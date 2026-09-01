//! Desktop storage and Tauri commands for the lot engine.
//!
//! The engine itself (`crate::lot_engine`) is pure and shared with the server. This module
//! is the desktop half that the engine must not know about: where the cleaned stacks live,
//! which slots are staged or removed, and what a saved lot is.
//!
//! # Where the stacks live
//!
//! **Not in SQLite, and not in the oplog.** A cleaned sheet is ~97k stacks; one row per
//! stack through `sync::record_upsert` would write ~97k event files and ~1.16M `row_clocks`
//! rows against a design assumption of about a thousand events on a heavy day, with no
//! pruning anywhere in either engine — and a batch too large for the push endpoint retries
//! every 20 seconds forever, blocking every later write in the org behind it.
//!
//! So the stacks are a `stacks.jsonl` artifact under `lot-engine/<sheet_id>/`, moved
//! between devices by the same durable, retrying queue lot photos use — but over an
//! AUTHENTICATED route rather than the public `/media` mount, because the file is every
//! product, price and shelf in the warehouse. Only the small rows — the sheet summary, the
//! slots you touched, and the lots you saved — are database rows, and those three do
//! replicate over the oplog.
//!
//! Ranking reads from an in-memory cache, filled once per sheet, so re-ranking every slot
//! on a keystroke never touches disk.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::db::pool;
use crate::lot_engine::export::{self, ManifestOpts};
use crate::lot_engine::model::{CleanResult, LotLine, Stack};
use crate::lot_engine::price::{lot_totals, LotTotals, Pricing};
use crate::lot_engine::rank::{auto_lots, rank, Allow, AutoPlan, AutoResult, RankOpts, RankResult, Want};
use crate::lot_engine::{pipeline, report};

const STACKS_FILE: &str = "stacks.jsonl";
const REPORT_FILE: &str = "quality-report.txt";
const AUDIT_FILE: &str = "location-audit-map.csv";
const CONFLICTS_FILE: &str = "barcode-conflicts.csv";

// ---------------------------------------------------------------------------------------
// Paths and the stack cache
// ---------------------------------------------------------------------------------------

/// Where a sheet's artifacts live on this device.
///
/// **Not under `sync/media/`.** That tree is uploaded to the server's public `/media`
/// mount, which has no auth — correct for lot photos and buyer manifests, wrong for
/// `stacks.jsonl`, which is every product, price and shelf in the warehouse. The artifact
/// moves between devices over an authenticated, org-scoped route instead
/// (`netsync::push_lot_artifacts` / `netsync::download_lot_artifact`).
fn sheet_dir(sheet_id: &str) -> Result<PathBuf, String> {
    let dir = crate::db::app_data_dir().join("lot-engine").join(sheet_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// True when this device already holds the cleaned stacks for a sheet. A sheet that
/// arrived over sync is a summary row and nothing else until the artifact follows it.
pub fn has_artifact(sheet_id: &str) -> bool {
    crate::db::app_data_dir()
        .join("lot-engine")
        .join(sheet_id)
        .join(STACKS_FILE)
        .exists()
}

/// Fetch the stacks from the server if this device does not have them yet.
///
/// Called by every command that needs stacks, so a sheet imported on the phone (or on
/// another desktop) becomes usable here the first time it is opened rather than erroring.
async fn ensure_artifact(sheet_id: &str) -> Result<(), String> {
    if has_artifact(sheet_id) {
        return Ok(());
    }
    let dir = sheet_dir(sheet_id)?;
    crate::netsync::download_lot_artifact(sheet_id, &dir.join(STACKS_FILE)).await
}

fn cache() -> &'static Mutex<HashMap<String, std::sync::Arc<Vec<Stack>>>> {
    static C: OnceLock<Mutex<HashMap<String, std::sync::Arc<Vec<Stack>>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stacks for a sheet, from memory if they are there and from the artifact if not.
///
/// One line of JSON per stack. A line that will not parse aborts the load with its line
/// number rather than being skipped: an importer that silently yields fewer stacks than the
/// file holds produces an empty lot, and an empty lot reads as a legal answer.
fn stacks_of(sheet_id: &str) -> Result<std::sync::Arc<Vec<Stack>>, String> {
    if let Some(v) = cache().lock().map_err(|e| e.to_string())?.get(sheet_id) {
        return Ok(v.clone());
    }
    let path = sheet_dir(sheet_id)?.join(STACKS_FILE);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("this sheet's data is missing from disk ({}): {e}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let s: Stack = serde_json::from_str(line)
            .map_err(|e| format!("line {} of {STACKS_FILE} is unreadable: {e}", i + 1))?;
        out.push(s);
    }
    apply_retail_overrides(sheet_id, &mut out);
    let arc = std::sync::Arc::new(out);
    cache()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(sheet_id.to_string(), arc.clone());
    Ok(arc)
}

/// Corrected retail prices, applied at the ONE place stacks are loaded.
///
/// Everything downstream — the facets, the ranking, the lot totals, all three exports — reads
/// its prices from here, so correcting one product corrects every figure that mentions it
/// rather than only the screen it was typed on. Keyed by exact title, matching how stage 5
/// already groups prices.
fn apply_retail_overrides(sheet_id: &str, stacks: &mut [Stack]) {
    let Some(map) = retail_overrides(sheet_id) else { return };
    if map.is_empty() {
        return;
    }
    for s in stacks.iter_mut() {
        if let Some(v) = map.get(s.title.trim()) {
            s.msrp = *v;
        }
    }
}

fn retail_overrides(sheet_id: &str) -> Option<std::collections::BTreeMap<String, f64>> {
    let conn = pool().get().ok()?;
    let raw: Option<String> = conn
        .query_row("SELECT price_overrides_json FROM lot_sheet WHERE id=?1", [sheet_id], |r| r.get(0))
        .ok()?;
    let raw = raw?;
    if raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str(&raw).ok()
}

/// Correct one product's retail on this sheet, or clear the correction with `None`.
///
/// The stack cache is dropped afterwards, or the old price would keep being served from
/// memory until the app restarted and the screen would argue with the database.
#[tauri::command]
pub async fn set_lot_retail(sheet_id: String, title: String, msrp: Option<f64>) -> Result<(), String> {
    let key = title.trim().to_string();
    if key.is_empty() {
        return Err("that product has no description to key a price to".into());
    }
    let mut map = retail_overrides(&sheet_id).unwrap_or_default();
    match msrp {
        Some(v) if v.is_finite() && v >= 0.0 => {
            map.insert(key, (v * 100.0).round() / 100.0);
        }
        Some(_) => return Err("a retail price has to be a number, and not negative".into()),
        None => {
            map.remove(&key);
        }
    }
    // A guard, not a limit anyone should hit: this rides in one JSON column on the sheet
    // row, and a five-figure map would make every sync event carry it.
    if map.len() > 5000 {
        return Err("too many corrected prices on one sheet — fix the source workbook instead".into());
    }
    let json = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_sheet SET price_overrides_json=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![sheet_id, json, now],
        )
        .map_err(|e| e.to_string())?;
    }
    cache().lock().map_err(|e| e.to_string())?.remove(&sheet_id);

    let mut cols = serde_json::Map::new();
    cols.insert("price_overrides_json".into(), serde_json::Value::String(json));
    cols.insert("updated_at".into(), serde_json::Value::String(now));
    emit("lot_sheet", &sheet_id, cols);
    Ok(())
}

/// One row per distinct product on the sheet, for the screen that corrects prices.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LotProduct {
    pub title: String,
    pub upc: String,
    pub brand: Option<String>,
    pub category: Option<String>,
    pub units: i64,
    /// The price in force — the corrected one when there is a correction.
    pub msrp: f64,
    /// True when this price came from a correction rather than from the sheet.
    pub overridden: bool,
    pub locations: usize,
}

#[tauri::command]
pub async fn lot_sheet_products(
    sheet_id: String,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<LotProduct>, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let overrides = retail_overrides(&sheet_id).unwrap_or_default();
    let q = query.unwrap_or_default().trim().to_ascii_lowercase();

    let mut by_title: std::collections::BTreeMap<&str, LotProduct> = Default::default();
    let mut where_seen: std::collections::BTreeMap<&str, HashSet<&str>> = Default::default();
    for s in stacks.iter() {
        let t = s.title.trim();
        if t.is_empty() {
            continue;
        }
        if !q.is_empty()
            && !t.to_ascii_lowercase().contains(&q)
            && !s.upc.to_ascii_lowercase().contains(&q)
            && !s.brand.as_deref().map(|b| b.to_ascii_lowercase().contains(&q)).unwrap_or(false)
        {
            continue;
        }
        where_seen.entry(t).or_default().insert(s.location.as_str());
        let e = by_title.entry(t).or_insert_with(|| LotProduct {
            title: t.to_string(),
            upc: s.upc.clone(),
            brand: s.brand.clone(),
            category: s.category.clone(),
            units: 0,
            msrp: s.msrp,
            overridden: overrides.contains_key(t),
            locations: 0,
        });
        e.units += s.units;
    }
    let mut out: Vec<LotProduct> = by_title
        .into_iter()
        .map(|(t, mut p)| {
            p.locations = where_seen.get(t).map(|s| s.len()).unwrap_or(0);
            p
        })
        .collect();
    // Biggest first: the products worth correcting are the ones carrying the units.
    out.sort_by(|a, b| b.units.cmp(&a.units).then(a.title.cmp(&b.title)));
    out.truncate(limit.unwrap_or(300));
    Ok(out)
}

fn write_stacks(sheet_id: &str, stacks: &[Stack]) -> Result<PathBuf, String> {
    let path = sheet_dir(sheet_id)?.join(STACKS_FILE);
    let mut out = String::with_capacity(stacks.len() * 180);
    for s in stacks {
        out.push_str(&serde_json::to_string(s).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(path)
}

/// A path relative to the app-data root, for storing in a row. Kept relative so a row that
/// syncs to another device does not carry this machine's directory layout with it.
fn rel(path: &PathBuf) -> String {
    let root = crate::db::app_data_dir();
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------------------
// Oplog
//
// The three small tables replicate; the stacks never do. `org_id` is deliberately absent
// from these events — the server stamps the pushing session's org onto every column map it
// accepts, and a desktop that guessed its own org could write into another one's.
//
// A failure to emit is logged, not returned: the local row is already written and correct,
// and refusing the whole command because replication is queued would be worse.
// ---------------------------------------------------------------------------------------

fn emit(table: &str, id: &str, cols: serde_json::Map<String, serde_json::Value>) {
    if let Err(e) = crate::sync::record_upsert(table, id, cols) {
        tracing::warn!("lot engine: could not record {table}/{id} for sync: {e}");
    }
}

fn cols(pairs: Vec<(&str, serde_json::Value)>) -> serde_json::Map<String, serde_json::Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn emit_slot(sheet_id: &str, loc: &str, state: &str, lot_id: Option<&str>, now: &str) {
    let key = format!("{sheet_id}{}{loc}", crate::lot_engine::model::KEY_SEP);
    emit(
        "lot_slot_state",
        &key,
        cols(vec![
            ("sheet_id", serde_json::json!(sheet_id)),
            ("location_code", serde_json::json!(loc)),
            ("state", serde_json::json!(state)),
            ("lot_id", serde_json::json!(lot_id)),
            // NOT NULL on the far side, so a peer seeing this row for the first time needs
            // one. Per-column last-writer-wins keeps the original on a row that exists.
            ("created_at", serde_json::json!(now)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LotSheet {
    pub id: String,
    pub name: String,
    pub source_filename: Option<String>,
    pub imported_at: String,
    pub rows_in: i64,
    pub stacks: i64,
    pub products: i64,
    pub units: i64,
    pub locations: i64,
    pub msrp_total: f64,
    pub artifact_path: Option<String>,
    pub report_path: Option<String>,
    pub audit_map_path: Option<String>,
    pub archived: bool,
    /// Slots already in a lot, and slots taken off the master list.
    pub staged_slots: i64,
    pub removed_slots: i64,
    /// True when the cleaned stacks are on THIS device. A sheet imported elsewhere arrives
    /// as a summary row first; the artifact follows over its own route, and until it does
    /// the sheet can be listed but not ranked.
    pub has_stacks: bool,
}

fn row_to_sheet(r: &rusqlite::Row) -> rusqlite::Result<LotSheet> {
    let id: String = r.get(0)?;
    Ok(LotSheet {
        id: id.clone(),
        name: r.get(1)?,
        source_filename: r.get(2)?,
        imported_at: r.get(3)?,
        rows_in: r.get(4)?,
        stacks: r.get(5)?,
        products: r.get(6)?,
        units: r.get(7)?,
        locations: r.get(8)?,
        msrp_total: r.get(9)?,
        artifact_path: r.get(10)?,
        report_path: r.get(11)?,
        audit_map_path: r.get(12)?,
        archived: r.get::<_, i64>(13)? != 0,
        staged_slots: r.get(14)?,
        removed_slots: r.get(15)?,
        has_stacks: has_artifact(&id),
    })
}

/// The 16 columns `row_to_sheet` reads, in its order. Kept apart from the FROM clause so a
/// caller can append its own columns without splicing text into the middle of a statement.
const SHEET_COLS: &str = "s.id, s.name, s.source_filename, s.imported_at, s.rows_in, \
    s.stacks, s.products, s.units, s.locations, s.msrp_total, s.artifact_path, s.report_path, \
    s.audit_map_path, s.archived, \
    (SELECT COUNT(*) FROM lot_slot_state x WHERE x.sheet_id = s.id AND x.state = 'staged'), \
    (SELECT COUNT(*) FROM lot_slot_state x WHERE x.sheet_id = s.id AND x.state = 'removed')";
const SHEET_FROM: &str = " FROM lot_sheet s";

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub sheet: LotSheet,
    pub quality: crate::lot_engine::model::QualityReport,
    pub detection: crate::lot_engine::model::SheetDetection,
    pub report_text: String,
}

// ---------------------------------------------------------------------------------------
// Commands — sheets
// ---------------------------------------------------------------------------------------

/// Read a warehouse sheet, clean it, and keep it.
///
/// Import is additive. A sheet is never overwritten in place and slot state is never
/// touched, so a refreshed export becomes a new sheet rather than silently rewriting the
/// one a lot was built against.
#[tauri::command]
pub async fn import_lot_sheet(path: String, name: Option<String>) -> Result<ImportResult, String> {
    let started = std::time::Instant::now();
    let source_filename = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string());
    let display_name = name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| source_filename.clone())
        .unwrap_or_else(|| "Warehouse sheet".to_string());

    let cleaned: CleanResult =
        tokio::task::spawn_blocking(move || pipeline::clean_path(&path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let dir = sheet_dir(&id)?;

    let artifact = write_stacks(&id, &cleaned.stacks)?;
    let report_text = report::quality_report_text(&cleaned, &display_name);
    let report_path = dir.join(REPORT_FILE);
    std::fs::write(&report_path, &report_text).map_err(|e| e.to_string())?;
    let audit_path = dir.join(AUDIT_FILE);
    std::fs::write(&audit_path, report::audit_map_csv(&cleaned)).map_err(|e| e.to_string())?;
    let conflicts_path = dir.join(CONFLICTS_FILE);
    std::fs::write(&conflicts_path, report::conflicts_csv(&cleaned)).map_err(|e| e.to_string())?;

    let q = cleaned.quality.clone();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO lot_sheet (id, name, source_filename, imported_at, rows_in, stacks, \
             products, units, locations, msrp_total, artifact_path, report_path, audit_map_path, \
             quality_json, detection_json, archived, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,0,?16,?16)",
            rusqlite::params![
                id,
                display_name,
                source_filename,
                now,
                q.rows_in as i64,
                q.stacks as i64,
                q.products as i64,
                q.units,
                q.locations as i64,
                q.msrp_total,
                rel(&artifact),
                rel(&report_path),
                rel(&audit_path),
                serde_json::to_string(&q).map_err(|e| e.to_string())?,
                serde_json::to_string(&cleaned.detection).map_err(|e| e.to_string())?,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    emit(
        "lot_sheet",
        &id,
        cols(vec![
            ("name", serde_json::json!(display_name)),
            ("source_filename", serde_json::json!(source_filename)),
            ("imported_at", serde_json::json!(now)),
            ("rows_in", serde_json::json!(q.rows_in as i64)),
            ("stacks", serde_json::json!(q.stacks as i64)),
            ("products", serde_json::json!(q.products as i64)),
            ("units", serde_json::json!(q.units)),
            ("locations", serde_json::json!(q.locations as i64)),
            ("msrp_total", serde_json::json!(q.msrp_total)),
            ("quality_json", serde_json::json!(serde_json::to_string(&q).unwrap_or_default())),
            (
                "detection_json",
                serde_json::json!(serde_json::to_string(&cleaned.detection).unwrap_or_default()),
            ),
            ("archived", serde_json::json!(0)),
            ("created_at", serde_json::json!(now)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    // The row alone is a summary. Queue the cleaned stacks so the other devices can
    // actually rank against this sheet — durable, so closing the app mid-upload retries
    // rather than stranding the only copy here.
    crate::netsync::media_enqueue(&id, &rel(&artifact), "lotsheet");

    cache()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), std::sync::Arc::new(cleaned.stacks));

    tracing::info!(
        "lot sheet {} imported: {} rows -> {} stacks in {:?}",
        id,
        q.rows_in,
        q.stacks,
        started.elapsed()
    );

    let sheet = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("SELECT {SHEET_COLS}{SHEET_FROM} WHERE s.id = ?1"), [&id], row_to_sheet)
            .map_err(|e| e.to_string())?
    };

    Ok(ImportResult {
        sheet,
        quality: q,
        detection: cleaned.detection,
        report_text,
    })
}

#[tauri::command]
pub async fn list_lot_sheets(include_archived: Option<bool>) -> Result<Vec<LotSheet>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = if include_archived.unwrap_or(false) {
        format!("SELECT {SHEET_COLS}{SHEET_FROM} ORDER BY s.imported_at DESC")
    } else {
        format!("SELECT {SHEET_COLS}{SHEET_FROM} WHERE s.archived = 0 ORDER BY s.imported_at DESC")
    };
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st.query_map([], row_to_sheet).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct SheetReport {
    pub sheet: LotSheet,
    pub quality: serde_json::Value,
    pub detection: serde_json::Value,
    pub report_text: String,
    pub report_path: Option<String>,
    pub audit_map_path: Option<String>,
}

/// Everything the import said about itself, for the quality screen.
#[tauri::command]
pub async fn lot_sheet_report(sheet_id: String) -> Result<SheetReport, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sheet, quality_json, detection_json): (LotSheet, Option<String>, Option<String>) = conn
        .query_row(
            &format!("SELECT {SHEET_COLS}, s.quality_json, s.detection_json{SHEET_FROM} WHERE s.id = ?1"),
            [&sheet_id],
            |r| Ok((row_to_sheet(r)?, r.get(16)?, r.get(17)?)),
        )
        .map_err(|e| e.to_string())?;

    // json_valid guards every read: json_extract RAISES on an empty string rather than
    // returning NULL, and one bad row blanked every financial screen once.
    let parse = |s: Option<String>| -> serde_json::Value {
        s.filter(|t| !t.trim().is_empty())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::Value::Null)
    };

    let report_text = sheet_dir(&sheet_id)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join(REPORT_FILE)).ok())
        .unwrap_or_default();

    Ok(SheetReport {
        report_path: sheet.report_path.clone(),
        audit_map_path: sheet.audit_map_path.clone(),
        sheet,
        quality: parse(quality_json),
        detection: parse(detection_json),
        report_text,
    })
}

#[tauri::command]
pub async fn rename_lot_sheet(sheet_id: String, name: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_sheet SET name = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![sheet_id, name, now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_sheet",
        &sheet_id,
        cols(vec![
            ("name", serde_json::json!(name)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    Ok(())
}

/// Archive, never delete. A sheet holds the only record of which slots were removed from
/// the master list, and removed means shipped.
#[tauri::command]
pub async fn archive_lot_sheet(sheet_id: String, archived: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_sheet SET archived = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![sheet_id, archived as i64, now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_sheet",
        &sheet_id,
        cols(vec![
            ("archived", serde_json::json!(archived as i64)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Commands — the pool, the facets and the ranking
// ---------------------------------------------------------------------------------------

/// Slots that are not in the pool: staged into a lot, or taken off the master list.
fn unavailable(sheet_id: &str) -> Result<HashSet<String>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare("SELECT location_code FROM lot_slot_state WHERE sheet_id = ?1 AND state IN ('staged','removed')")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([sheet_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = HashSet::new();
    for r in rows {
        out.insert(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct Facet {
    pub name: String,
    pub units: i64,
    pub slots: usize,
}

/// What is actually in the pool, so the filter panel offers real choices with real counts
/// rather than a list of everything the dictionary knows about.
#[derive(Debug, Clone, Serialize)]
pub struct Facets {
    pub brands: Vec<Facet>,
    pub categories: Vec<Facet>,
    pub segments: Vec<Facet>,
    pub size_min: Option<f64>,
    pub size_max: Option<f64>,
    pub msrp_min: f64,
    pub msrp_max: f64,
    pub pool_slots: usize,
    pub pool_units: i64,
    pub pool_msrp: f64,
}

#[tauri::command]
pub async fn lot_sheet_facets(sheet_id: String) -> Result<Facets, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let gone = unavailable(&sheet_id)?;

    let mut brands: HashMap<String, (i64, HashSet<&str>)> = HashMap::new();
    let mut cats: HashMap<String, (i64, HashSet<&str>)> = HashMap::new();
    let mut segs: HashMap<String, (i64, HashSet<&str>)> = HashMap::new();
    let mut slots: HashSet<&str> = HashSet::new();
    let (mut units, mut msrp) = (0i64, 0.0f64);
    let (mut smin, mut smax): (Option<f64>, Option<f64>) = (None, None);
    let (mut pmin, mut pmax) = (f64::MAX, 0.0f64);

    for s in stacks.iter() {
        if gone.contains(&s.location) {
            continue;
        }
        slots.insert(s.location.as_str());
        units += s.units;
        msrp += s.msrp * s.units as f64;
        if s.msrp > 0.0 {
            pmin = pmin.min(s.msrp);
            pmax = pmax.max(s.msrp);
        }
        if let Some(z) = s.size_us {
            smin = Some(smin.map_or(z, |m: f64| m.min(z)));
            smax = Some(smax.map_or(z, |m: f64| m.max(z)));
        }
        for (map, key) in [
            (&mut brands, s.brand.clone()),
            (&mut cats, s.category.clone()),
            (&mut segs, s.segment.clone()),
        ] {
            let Some(k) = key else { continue };
            let e = map.entry(k).or_insert((0, HashSet::new()));
            e.0 += s.units;
            e.1.insert(s.location.as_str());
        }
    }

    let finish = |m: HashMap<String, (i64, HashSet<&str>)>| -> Vec<Facet> {
        let mut v: Vec<Facet> = m
            .into_iter()
            .map(|(name, (units, slots))| Facet {
                name,
                units,
                slots: slots.len(),
            })
            .collect();
        v.sort_by(|a, b| b.units.cmp(&a.units).then(a.name.cmp(&b.name)));
        v
    };

    Ok(Facets {
        brands: finish(brands),
        categories: finish(cats),
        segments: finish(segs),
        size_min: smin,
        size_max: smax,
        msrp_min: if pmin == f64::MAX { 0.0 } else { pmin },
        msrp_max: pmax,
        pool_slots: slots.len(),
        pool_units: units,
        pool_msrp: msrp,
    })
}

/// The headline. Ranks every available slot and returns the top ones.
///
/// Runs against the in-memory cache, so the whole pass is a linear walk over stacks already
/// sorted by location. Called on every keystroke behind the UI's debounce.
#[tauri::command]
pub async fn rank_lot_slots(
    sheet_id: String,
    want: Want,
    allow: Allow,
    opts: RankOpts,
    exclude: Option<Vec<String>>,
) -> Result<RankResult, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let mut gone = unavailable(&sheet_id)?;
    // Slots already picked into the lot on screen but not yet saved. They leave the pool
    // the moment they are picked, so the header counts and every later search only show
    // what is still unclaimed.
    if let Some(x) = exclude {
        gone.extend(x);
    }
    Ok(rank(&stacks, &want, &allow, &opts, &gone))
}

/// Cut the qualifying pool into as many ~`target_units` lots as it allows.
///
/// A **preview only** — nothing is written. The caller shows the plan and a person decides;
/// saving is the ordinary `save_lot_build` path, once per lot, so a planned lot goes through
/// exactly the same staging and the same checks as one built by hand.
#[tauri::command]
pub async fn plan_lot_builds(
    sheet_id: String,
    want: Want,
    allow: Allow,
    opts: RankOpts,
    plan: AutoPlan,
    exclude: Option<Vec<String>>,
) -> Result<AutoResult, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let mut gone = unavailable(&sheet_id)?;
    if let Some(x) = exclude {
        gone.extend(x);
    }
    Ok(auto_lots(&stacks, &want, &allow, &opts, &gone, &plan))
}

/// Totals for a lot being built, before it is saved.
///
/// Exists so the running figures on screen come from the same `lot_totals` the manifest and
/// the saved record use. A UI that added up its own prices would drift from the document the
/// buyer receives, and per-category percentages make that drift silent.
#[tauri::command]
pub async fn preview_lot_totals(
    sheet_id: String,
    slots: Vec<String>,
    price_pct: f64,
    price_overrides: Option<String>,
    cost_pct: Option<f64>,
    cost_overrides: Option<String>,
) -> Result<LotTotals, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let want: HashSet<&str> = slots.iter().map(|s| s.as_str()).collect();
    let lot: Vec<Stack> = stacks
        .iter()
        .filter(|s| want.contains(s.location.as_str()))
        .cloned()
        .collect();
    Ok(lot_totals(
        &lot,
        &pricing_with_cost(
            price_pct,
            price_overrides.as_deref(),
            cost_pct.unwrap_or(0.0),
            cost_overrides.as_deref(),
        ),
    ))
}

/// Everything in one slot — what you are actually taking.
#[tauri::command]
pub async fn lot_slot_contents(sheet_id: String, location: String) -> Result<Vec<Stack>, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    Ok(stacks
        .iter()
        .filter(|s| s.location == location)
        .cloned()
        .collect())
}

// ---------------------------------------------------------------------------------------
// Commands — slot state
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SlotState {
    pub location_code: String,
    pub state: String,
    pub lot_id: Option<String>,
    pub updated_at: String,
}

/// Move slots between available, staged and removed.
///
/// `state` is `available`, `staged` or `removed`. Returning a slot to the pool UPDATES its
/// row to `available`; it never deletes it. A delete would write a permanent tombstone and
/// `apply_upsert` skips any later event whose tombstone is at or past its clock, so a
/// staged → available → staged cycle would make the slot unrecreatable under the same key.
#[tauri::command]
pub async fn set_lot_slot_state(
    sheet_id: String,
    locations: Vec<String>,
    state: String,
    lot_id: Option<String>,
    note: Option<String>,
) -> Result<usize, String> {
    if !matches!(state.as_str(), "available" | "staged" | "removed") {
        return Err(format!("{state:?} is not a slot state"));
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut n = 0usize;
    for loc in &locations {
        // Composite key joined with a character that cannot occur in the data.
        let id = format!("{sheet_id}\u{1}{loc}");
        conn.execute(
            "INSERT INTO lot_slot_state (id, sheet_id, location_code, state, lot_id, note, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7) \
             ON CONFLICT(id) DO UPDATE SET state=excluded.state, lot_id=excluded.lot_id, \
             note=COALESCE(excluded.note, lot_slot_state.note), updated_at=excluded.updated_at",
            rusqlite::params![id, sheet_id, loc, state, lot_id, note, now],
        )
        .map_err(|e| e.to_string())?;
        n += 1;
    }
    drop(conn);
    for loc in &locations {
        emit_slot(&sheet_id, loc, &state, lot_id.as_deref(), &now);
    }
    Ok(n)
}

#[tauri::command]
pub async fn list_lot_slot_states(sheet_id: String) -> Result<Vec<SlotState>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare(
            "SELECT location_code, state, lot_id, updated_at FROM lot_slot_state \
             WHERE sheet_id = ?1 AND state <> 'available' ORDER BY location_code",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([&sheet_id], |r| {
            Ok(SlotState {
                location_code: r.get(0)?,
                state: r.get(1)?,
                lot_id: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Commands — saved lots
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LotBuild {
    pub id: String,
    pub sheet_id: String,
    pub sheet_name: Option<String>,
    pub name: String,
    pub status: String,
    pub price_pct: f64,
    pub price_pct_json: Option<String>,
    pub locations: i64,
    pub units: i64,
    pub styles: i64,
    pub msrp_total: f64,
    pub ask_total: f64,
    pub slots: Vec<String>,
    pub notes: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    /// What the lot COST, as a share of MSRP applied per line — the same shape as
    /// `price_pct`, which is what the customer pays. Zero means **not recorded**, not free;
    /// `LotTotals::cost_known` is what tells those apart, and every surface must read it
    /// before printing a margin.
    pub cost_pct: f64,
    pub cost_pct_json: Option<String>,
    /// The node this lot sits inside, or `None` at the top level (R-218).
    pub parent_id: Option<String>,
    /// `lot` | `combined` | `branch`. The level tag, and the cycle guard.
    ///
    /// **Only a `lot` owns slots.** A `combined` and a `branch` carry an empty `slots` and
    /// must never be handed to `set_lot_slot_state` -- see migration 86 for why.
    pub kind: String,
    /// Stamped when `status` became `sold`. `None` otherwise.
    pub sold_at: Option<String>,
}

fn row_to_build(r: &rusqlite::Row) -> rusqlite::Result<LotBuild> {
    let slots_json: Option<String> = r.get(12)?;
    Ok(LotBuild {
        id: r.get(0)?,
        sheet_id: r.get(1)?,
        name: r.get(2)?,
        status: r.get(3)?,
        price_pct: r.get(4)?,
        price_pct_json: r.get(5)?,
        locations: r.get(6)?,
        units: r.get(7)?,
        styles: r.get(8)?,
        msrp_total: r.get(9)?,
        ask_total: r.get(10)?,
        notes: r.get(11)?,
        slots: slots_json
            .filter(|s| !s.trim().is_empty())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        archived: r.get::<_, i64>(13)? != 0,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        sheet_name: r.get(16)?,
        // Appended to BUILD_SELECT rather than inserted, so every index above is unmoved.
        cost_pct: r.get(17).unwrap_or(0.0),
        cost_pct_json: r.get(18).unwrap_or(None),
        // Appended for the same reason. A row written before migration 86 has no parent and
        // no kind, which is exactly what a base lot at the top level is.
        parent_id: r.get(19).unwrap_or(None),
        kind: r
            .get::<_, Option<String>>(20)
            .unwrap_or(None)
            .unwrap_or_else(|| "lot".into()),
        sold_at: r.get(21).unwrap_or(None),
    })
}

const BUILD_SELECT: &str = "SELECT b.id, b.sheet_id, b.name, b.status, b.price_pct, \
    b.price_pct_json, b.locations, b.units, b.styles, b.msrp_total, b.ask_total, b.notes, \
    b.slots_json, b.archived, b.created_at, b.updated_at, s.name, b.cost_pct, b.cost_pct_json, \
    b.parent_id, b.kind, b.sold_at \
    FROM lot_build b LEFT JOIN lot_sheet s ON s.id = b.sheet_id";

fn pricing_from(pct: f64, overrides: Option<&str>) -> Pricing {
    pricing_with_cost(pct, overrides, 0.0, None)
}

/// The ask side and the cost side, read the same way. A blank or unparseable override map
/// leaves the flat percentage standing rather than failing the whole lot.
fn pricing_with_cost(
    pct: f64,
    overrides: Option<&str>,
    cost_pct: f64,
    cost_overrides: Option<&str>,
) -> Pricing {
    let map = |j: Option<&str>| -> Option<std::collections::BTreeMap<String, f64>> {
        j.filter(|s| !s.trim().is_empty())
            .and_then(|s| serde_json::from_str(s).ok())
    };
    let mut p = Pricing::flat(pct);
    if let Some(m) = map(overrides) {
        p.overrides = m;
    }
    p.cost_pct = cost_pct;
    if let Some(m) = map(cost_overrides) {
        p.cost_overrides = m;
    }
    p
}

/// Save the lot being built, and stage its slots so nothing can be sold twice.
///
/// Staging is automatic — the slots leave the pool the moment the lot is saved. Taking them
/// off the master list for good is a separate, deliberate action:
/// [`remove_lot_from_master_list`].
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_lot_build(
    sheet_id: String,
    build_id: Option<String>,
    name: String,
    slots: Vec<String>,
    price_pct: f64,
    price_overrides: Option<String>,
    cost_pct: Option<f64>,
    cost_overrides: Option<String>,
    notes: Option<String>,
) -> Result<LotBuild, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let want: HashSet<&str> = slots.iter().map(|s| s.as_str()).collect();
    let lot: Vec<Stack> = stacks
        .iter()
        .filter(|s| want.contains(s.location.as_str()))
        .cloned()
        .collect();
    if lot.is_empty() {
        return Err("that lot has no stock in it — add some locations first".into());
    }

    let pricing = pricing_with_cost(
        price_pct,
        price_overrides.as_deref(),
        cost_pct.unwrap_or(0.0),
        cost_overrides.as_deref(),
    );
    let t: LotTotals = lot_totals(&lot, &pricing);

    let id = build_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let mut ordered: Vec<String> = slots.clone();
    ordered.sort();
    ordered.dedup();

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO lot_build (id, sheet_id, name, status, price_pct, price_pct_json, \
             locations, units, styles, msrp_total, ask_total, brands_json, categories_json, \
             title_risk_json, slots_json, notes, archived, created_at, updated_at, \
             cost_pct, cost_pct_json) \
             VALUES (?1,?2,?3,'saved',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,0,?16,?16,?17,?18) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, price_pct=excluded.price_pct, \
             price_pct_json=excluded.price_pct_json, locations=excluded.locations, \
             units=excluded.units, styles=excluded.styles, msrp_total=excluded.msrp_total, \
             ask_total=excluded.ask_total, brands_json=excluded.brands_json, \
             categories_json=excluded.categories_json, title_risk_json=excluded.title_risk_json, \
             slots_json=excluded.slots_json, notes=excluded.notes, updated_at=excluded.updated_at, \
             cost_pct=excluded.cost_pct, cost_pct_json=excluded.cost_pct_json",
            rusqlite::params![
                id,
                sheet_id,
                name,
                pricing.pct,
                serde_json::to_string(&pricing.overrides).ok(),
                t.locations as i64,
                t.units,
                t.styles as i64,
                t.msrp,
                t.ask,
                serde_json::to_string(&t.by_brand).ok(),
                serde_json::to_string(&t.by_category).ok(),
                serde_json::to_string(&t.title_risk_units).ok(),
                serde_json::to_string(&ordered).ok(),
                notes,
                now,
                pricing.cost_pct,
                serde_json::to_string(&pricing.cost_overrides).ok(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    emit(
        "lot_build",
        &id,
        cols(vec![
            ("sheet_id", serde_json::json!(sheet_id)),
            ("name", serde_json::json!(name)),
            ("status", serde_json::json!(status_of(&id))),
            ("price_pct", serde_json::json!(pricing.pct)),
            ("price_pct_json", serde_json::json!(serde_json::to_string(&pricing.overrides).ok())),
            ("locations", serde_json::json!(t.locations as i64)),
            ("units", serde_json::json!(t.units)),
            ("styles", serde_json::json!(t.styles as i64)),
            ("msrp_total", serde_json::json!(t.msrp)),
            ("ask_total", serde_json::json!(t.ask)),
            ("brands_json", serde_json::json!(serde_json::to_string(&t.by_brand).ok())),
            ("categories_json", serde_json::json!(serde_json::to_string(&t.by_category).ok())),
            ("title_risk_json", serde_json::json!(serde_json::to_string(&t.title_risk_units).ok())),
            ("slots_json", serde_json::json!(serde_json::to_string(&ordered).ok())),
            ("notes", serde_json::json!(notes)),
            ("archived", serde_json::json!(0)),
            ("created_at", serde_json::json!(now)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );

    // Staging emits its own slot events.
    set_lot_slot_state(
        sheet_id.clone(),
        ordered.clone(),
        "staged".into(),
        Some(id.clone()),
        None,
    )
    .await?;

    lot_build_detail(id).await.map(|d| d.build)
}

/// The status the row ACTUALLY carries, for an emit that must not overwrite it.
///
/// `save_lot_build`'s `ON CONFLICT` list deliberately leaves `status` alone on an update, so
/// broadcasting a flat "saved" would un-sell a sold lot and un-send a sent one on every
/// OTHER device while this one stayed correct. Latent while `sent` was the only other value
/// and nothing re-saved an existing lot; live the moment `sold` exists.
fn status_of(id: &str) -> String {
    pool()
        .get()
        .ok()
        .and_then(|c| {
            c.query_row("SELECT status FROM lot_build WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        })
        .unwrap_or_else(|| "saved".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct LotBuildDetail {
    pub build: LotBuild,
    pub totals: LotTotals,
    pub location_codes: String,
}

#[tauri::command]
pub async fn lot_build_detail(build_id: String) -> Result<LotBuildDetail, String> {
    let build = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
            .map_err(|e| e.to_string())?
    };
    ensure_artifact(&build.sheet_id).await?;
    let lot = build_stacks(&build)?;
    let pricing = pricing_with_cost(
        build.price_pct,
        build.price_pct_json.as_deref(),
        build.cost_pct,
        build.cost_pct_json.as_deref(),
    );
    Ok(LotBuildDetail {
        totals: lot_totals(&lot, &pricing),
        location_codes: export::location_codes(&lot),
        build,
    })
}

fn build_stacks(build: &LotBuild) -> Result<Vec<Stack>, String> {
    let stacks = stacks_of(&build.sheet_id)?;
    // A `lot` owns its slots. A `combined` or a `branch` owns none -- its stock is the union
    // of the live base lots underneath it, so it has to be walked. Sold and archived
    // descendants are excluded, which is what stops a parent overstating itself after one of
    // its children has been sold out from under it (R-218: "just flag it, dont dissolve").
    let want: HashSet<String> = if build.kind == "lot" {
        build.slots.iter().cloned().collect()
    } else {
        live_leaf_slots(&build.id)?.into_iter().collect()
    };
    Ok(stacks
        .iter()
        .filter(|s| want.contains(s.location.as_str()))
        .cloned()
        .collect())
}

// ---------------------------------------------------------------------------------------
// The lot tree (R-218)
//
// Three levels: a `branch` holds `combined` lots, a `combined` holds base `lot`s, and a
// base lot is the only kind that owns warehouse slots. `parent_id` is the only edge.
//
// **Only a base lot may ever be handed to `set_lot_slot_state`.** `lot_slot_state.lot_id` is
// a single scalar, overwritten unconditionally, so a parent staging its children's slots
// would steal them -- after which archiving a child frees nothing and archiving the parent
// frees every child at once. Nothing below writes a slot row; that is the whole design.
// ---------------------------------------------------------------------------------------

/// Every id at or below `id`, the node itself first.
///
/// One statement, so it cannot half-read. The `kind` ladder enforced by `check_parent` is
/// what guarantees this terminates -- a cycle in `parent_id` would spin here forever, and on
/// the server the identical query would do it while holding the process-wide connection
/// guard.
fn subtree(conn: &rusqlite::Connection, id: &str) -> Result<Vec<String>, String> {
    let mut st = conn
        .prepare(
            "WITH RECURSIVE tree(id) AS ( \
               SELECT ?1 \
               UNION \
               SELECT b.id FROM lot_build b JOIN tree t ON b.parent_id = t.id \
             ) SELECT id FROM tree",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// The slots of every base lot under `id` that is still live -- not sold, not archived.
fn live_leaf_slots(id: &str) -> Result<Vec<String>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let ids = subtree(&conn, id)?;
    let mut out: Vec<String> = Vec::new();
    for child in ids.iter().filter(|c| c.as_str() != id) {
        let row: Option<(String, String, String, i64)> = conn
            .query_row(
                "SELECT kind, status, COALESCE(slots_json,'[]'), archived FROM lot_build WHERE id=?1",
                [child],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        let Some((kind, status, slots_json, archived)) = row else { continue };
        if kind != "lot" || status == "sold" || archived != 0 {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Vec<String>>(&slots_json) {
            out.extend(v);
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Recompute a node's stored figures from the live base lots beneath it, and replicate them.
///
/// Called after every membership change and after every sale, because the roster reads these
/// stored columns -- and there is no `reconcile` for a roster. `reconcile` is hard-typed to
/// the three stack documents and returns Ok trivially on an empty lot, so a parent whose
/// numbers had drifted would be caught by nothing.
fn recompute_node(node_id: &str) -> Result<(), String> {
    let build = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [node_id], row_to_build)
            .map_err(|e| e.to_string())?
    };
    if build.kind == "lot" {
        return Ok(());
    }
    let lot = build_stacks(&build)?;
    let pricing = pricing_with_cost(
        build.price_pct,
        build.price_pct_json.as_deref(),
        build.cost_pct,
        build.cost_pct_json.as_deref(),
    );
    let t = lot_totals(&lot, &pricing);
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_build SET locations=?2, units=?3, styles=?4, msrp_total=?5, ask_total=?6, \
             brands_json=?7, categories_json=?8, title_risk_json=?9, updated_at=?10 WHERE id=?1",
            rusqlite::params![
                node_id,
                t.locations as i64,
                t.units,
                t.styles as i64,
                t.msrp,
                t.ask,
                serde_json::to_string(&t.by_brand).ok(),
                serde_json::to_string(&t.by_category).ok(),
                serde_json::to_string(&t.title_risk_units).ok(),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_build",
        node_id,
        cols(vec![
            ("locations", serde_json::json!(t.locations as i64)),
            ("units", serde_json::json!(t.units)),
            ("styles", serde_json::json!(t.styles as i64)),
            ("msrp_total", serde_json::json!(t.msrp)),
            ("ask_total", serde_json::json!(t.ask)),
            ("brands_json", serde_json::json!(serde_json::to_string(&t.by_brand).ok())),
            ("categories_json", serde_json::json!(serde_json::to_string(&t.by_category).ok())),
            ("title_risk_json", serde_json::json!(serde_json::to_string(&t.title_risk_units).ok())),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    Ok(())
}

/// Walk up and recompute every ancestor. A base lot selling changes its combined lot's
/// figures, which changes its branch's.
fn recompute_ancestors(mut id: Option<String>) -> Result<(), String> {
    let mut guard = 0;
    while let Some(cur) = id {
        // The kind ladder makes a cycle impossible; this is the belt to its braces, because
        // the cost of being wrong is an infinite loop inside a command.
        guard += 1;
        if guard > 8 {
            break;
        }
        recompute_node(&cur)?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        id = conn
            .query_row("SELECT parent_id FROM lot_build WHERE id=?1", [&cur], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap_or(None);
    }
    Ok(())
}

/// The kind ladder, checked before any write. It is what makes a cycle structurally
/// impossible, so it is also the cycle guard.
fn check_parent(child_kind: &str, parent: Option<&LotBuild>) -> Result<(), String> {
    match (child_kind, parent) {
        ("branch", None) => Ok(()),
        ("branch", Some(_)) => Err("a branch is a top level and cannot go inside anything".into()),
        ("combined", Some(p)) if p.kind == "branch" => Ok(()),
        ("combined", _) => Err("a combined lot has to sit inside a branch".into()),
        ("lot", None) => Ok(()),
        ("lot", Some(p)) if p.kind == "combined" => Ok(()),
        ("lot", Some(_)) => Err("a lot goes inside a combined lot, not directly inside a branch".into()),
        _ => Err(format!("{child_kind} is not a kind of lot")),
    }
}

/// Write a node row that owns no slots. Branches and combined lots only.
fn insert_node(
    id: &str,
    sheet_id: &str,
    name: &str,
    kind: &str,
    parent_id: Option<&str>,
    price_pct: f64,
    cost_pct: f64,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO lot_build (id, sheet_id, name, status, price_pct, locations, units, \
             styles, msrp_total, ask_total, slots_json, archived, created_at, updated_at, \
             cost_pct, parent_id, kind) \
             VALUES (?1,?2,?3,'saved',?4,0,0,0,0,0,'[]',0,?5,?5,?6,?7,?8)",
            rusqlite::params![id, sheet_id, name, price_pct, now, cost_pct, parent_id, kind],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_build",
        id,
        cols(vec![
            ("sheet_id", serde_json::json!(sheet_id)),
            ("name", serde_json::json!(name)),
            ("status", serde_json::json!("saved")),
            ("price_pct", serde_json::json!(price_pct)),
            ("cost_pct", serde_json::json!(cost_pct)),
            ("slots_json", serde_json::json!("[]")),
            ("archived", serde_json::json!(0)),
            ("parent_id", serde_json::json!(parent_id)),
            ("kind", serde_json::json!(kind)),
            ("created_at", serde_json::json!(now)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    Ok(())
}

/// Make a branch -- the named section that holds combined lots and owns a spreadsheet.
#[tauri::command]
pub async fn create_lot_branch(sheet_id: String, name: String) -> Result<LotBuild, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a branch needs a name -- it is the heading on its own spreadsheet".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    insert_node(&id, &sheet_id, &name, "branch", None, 0.0, 0.0)?;
    lot_build_detail(id).await.map(|d| d.build)
}

/// Combine several base lots into one, inside a branch.
///
/// The children **stay live and sellable** and keep their own slots -- Jack chose this over
/// a merge that consumes them. Nothing here touches `lot_slot_state`: ownership stays with
/// the base lot that staged the slot, which is what keeps archive and remove-from-list
/// working untouched.
#[tauri::command]
pub async fn combine_lot_builds(
    sheet_id: String,
    branch_id: String,
    name: String,
    child_ids: Vec<String>,
    price_pct: f64,
    cost_pct: Option<f64>,
) -> Result<LotBuild, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("give the combined lot a name -- it is a row on the branch's spreadsheet".into());
    }
    if child_ids.len() < 2 {
        return Err("pick at least two lots to combine".into());
    }
    let branch = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&branch_id], row_to_build)
            .map_err(|_| "that branch no longer exists".to_string())?
    };
    if branch.kind != "branch" {
        return Err("a combined lot has to go inside a branch".into());
    }
    check_parent("combined", Some(&branch))?;

    // Validate every child BEFORE writing anything. There are no transactions in this file,
    // so the only way not to half-apply is not to start.
    let kids: Vec<LotBuild> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for cid in &child_ids {
            let b = conn
                .query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [cid], row_to_build)
                .map_err(|_| format!("one of the lots you picked no longer exists ({cid})"))?;
            out.push(b);
        }
        out
    };
    for k in &kids {
        if k.kind != "lot" {
            return Err(format!("{} is not a base lot, so it cannot go in here", k.name));
        }
        if k.sheet_id != sheet_id {
            return Err(format!("{} came from a different warehouse sheet", k.name));
        }
        if k.archived {
            return Err(format!("{} is archived", k.name));
        }
        if k.status == "sold" {
            return Err(format!("{} has already been sold", k.name));
        }
        if k.status == "sent" {
            return Err(format!("{} has already left the building", k.name));
        }
        if let Some(p) = &k.parent_id {
            if p != &branch_id {
                return Err(format!(
                    "{} is already inside another combined lot -- take it out of that one first",
                    k.name
                ));
            }
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    insert_node(&id, &sheet_id, &name, "combined", Some(&branch_id), price_pct, cost_pct.unwrap_or(0.0))?;

    let now = chrono::Utc::now().to_rfc3339();
    for k in &kids {
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE lot_build SET parent_id=?2, updated_at=?3 WHERE id=?1",
                rusqlite::params![k.id, id, now],
            )
            .map_err(|e| e.to_string())?;
        }
        emit(
            "lot_build",
            &k.id,
            cols(vec![
                ("parent_id", serde_json::json!(id)),
                ("updated_at", serde_json::json!(now)),
            ]),
        );
    }

    recompute_node(&id)?;
    recompute_node(&branch_id)?;
    lot_build_detail(id).await.map(|d| d.build)
}

/// Move a lot into a node, or take it back out to the top level.
#[tauri::command]
pub async fn set_lot_parent(build_id: String, parent_id: Option<String>) -> Result<(), String> {
    let (child, old_parent) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let b = conn
            .query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
            .map_err(|e| e.to_string())?;
        let p = b.parent_id.clone();
        (b, p)
    };
    let parent = match &parent_id {
        Some(pid) => {
            if pid == &build_id {
                return Err("a lot cannot contain itself".into());
            }
            let conn = pool().get().map_err(|e| e.to_string())?;
            let p = conn
                .query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [pid], row_to_build)
                .map_err(|_| "that lot no longer exists".to_string())?;
            if p.sheet_id != child.sheet_id {
                return Err("those two lots came from different warehouse sheets".into());
            }
            // Belt and braces against a cycle: the ladder already forbids it, but a bad
            // parent_id here would spin `subtree` forever.
            let conn2 = pool().get().map_err(|e| e.to_string())?;
            if subtree(&conn2, &build_id)?.iter().any(|d| d == pid) {
                return Err("that would put a lot inside itself".into());
            }
            Some(p)
        }
        None => None,
    };
    check_parent(&child.kind, parent.as_ref())?;

    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_build SET parent_id=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![build_id, parent_id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_build",
        &build_id,
        cols(vec![
            ("parent_id", serde_json::json!(parent_id)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    // Both sides of the move: the node it left shrinks, the node it joined grows.
    recompute_ancestors(old_parent)?;
    recompute_ancestors(parent_id)?;
    Ok(())
}

/// One row per lot on a level, in the shape of the master spreadsheet Jack keeps by hand.
///
/// **One sheet per level, which is what he asked for**: *"the small lots should always still
/// exist because they will be their own spreadsheet. then when i create a branch of
/// combining bigger lots, that specific section will be its own spreadsheet."*
///
/// * `node_id` = `None` -> the base lots of a sheet, which is his existing master list.
/// * `node_id` = a branch -> the combined lots inside it.
/// * `node_id` = a combined lot -> the base lots inside it.
///
/// A **sold** lot is off its sheet -- that is the rule he stated. So is an archived one. The
/// predicate is spelled identically here and on the server; two surfaces handing out
/// different spreadsheets for the same branch is the whole failure this is written to avoid.
#[tauri::command]
pub async fn lot_roster_lines(
    sheet_id: String,
    node_id: Option<String>,
) -> Result<Vec<LotLine>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sql, args): (String, Vec<String>) = match &node_id {
        Some(n) => (
            "SELECT name, units, msrp_total, ask_total FROM lot_build \
             WHERE parent_id = ?1 AND archived = 0 AND status = 'saved' ORDER BY name"
                .into(),
            vec![n.clone()],
        ),
        None => (
            "SELECT name, units, msrp_total, ask_total FROM lot_build \
             WHERE sheet_id = ?1 AND kind = 'lot' AND parent_id IS NULL AND archived = 0 \
             AND status = 'saved' ORDER BY name"
                .into(),
            vec![sheet_id.clone()],
        ),
    };
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok(LotLine {
                reference: r.get(0)?,
                units: r.get(1)?,
                retail: r.get(2)?,
                sale: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Write that roster to a file the person picks.
///
/// Always through the save dialog, never the default export path: those are built from the
/// lot's name with every non-alphanumeric mapped to a dash, so a branch and a lot with
/// similar names would overwrite each other's spreadsheet in silence.
#[tauri::command]
pub async fn export_lot_roster(
    sheet_id: String,
    node_id: Option<String>,
    title: String,
    path: String,
) -> Result<ExportResult, String> {
    let lines = lot_roster_lines(sheet_id, node_id).await?;
    if lines.is_empty() {
        return Err("there is nothing on that spreadsheet yet".into());
    }
    let doc = export::lot_roster(&lines, &title);
    let p = std::path::PathBuf::from(&path);
    let bytes = if p.extension().map(|e| e.eq_ignore_ascii_case("xlsx")).unwrap_or(false) {
        export::to_xlsx(&doc).map_err(|e| e.to_string())?
    } else {
        export::to_csv(&doc).into_bytes()
    };
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    // `reconciled` is true because there is nothing to reconcile: the three-way check is
    // over a lot's stacks, and a roster is a list of lots. Saying false would read as a
    // failed check rather than an inapplicable one.
    Ok(ExportResult { path, rows: lines.len(), reconciled: true })
}

/// Mark a lot sold, and everything inside it with it.
///
/// **Sold is a status and nothing else.** It never writes `lot_slot_state`, never sets
/// `sent`, and never sets `removed` -- shipping stays the separate, deliberately
/// irreversible press ("absent means shipped, not undone"). A lot can be sold long before
/// it leaves the building.
///
/// The cascade is ONE statement. There are no transactions anywhere in this file, so a loop
/// of updates could half-apply with no record and no repair path.
#[tauri::command]
pub async fn mark_lot_sold(build_id: String, sold: bool) -> Result<usize, String> {
    let build = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
            .map_err(|e| e.to_string())?
    };
    if sold && build.status == "sent" {
        return Err("that lot has already left the building".into());
    }
    let (from, to) = if sold { ("saved", "sold") } else { ("sold", "saved") };
    let now = chrono::Utc::now().to_rfc3339();
    let sold_at = if sold { Some(now.clone()) } else { None };

    // Read the affected set first, so each row can be replicated by name afterwards.
    let ids = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        subtree(&conn, &build_id)?
    };
    let n = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_build SET status=?2, sold_at=?3, updated_at=?4 \
             WHERE status=?5 AND id IN ( \
               WITH RECURSIVE tree(id) AS ( \
                 SELECT ?1 UNION SELECT b.id FROM lot_build b JOIN tree t ON b.parent_id = t.id \
               ) SELECT id FROM tree)",
            rusqlite::params![build_id, to, sold_at, now, from],
        )
        .map_err(|e| e.to_string())?
    };
    for id in &ids {
        emit(
            "lot_build",
            id,
            cols(vec![
                ("status", serde_json::json!(status_of(id))),
                ("sold_at", serde_json::json!(sold_at)),
                ("updated_at", serde_json::json!(now)),
            ]),
        );
    }
    // Everything above it shrinks (or grows back), so a parent never overstates what is
    // still in it. The parent is NOT dissolved -- Jack: "just flag it, dont dissolve the
    // parent" -- it survives with smaller figures, and the UI names what left.
    recompute_ancestors(build.parent_id.clone())?;
    Ok(n)
}


#[tauri::command]
pub async fn list_lot_builds(sheet_id: Option<String>) -> Result<Vec<LotBuild>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sql, args): (String, Vec<String>) = match sheet_id {
        Some(s) => (
            format!("{BUILD_SELECT} WHERE b.archived = 0 AND b.sheet_id = ?1 ORDER BY b.updated_at DESC"),
            vec![s],
        ),
        None => (
            format!("{BUILD_SELECT} WHERE b.archived = 0 ORDER BY b.updated_at DESC"),
            vec![],
        ),
    };
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(rusqlite::params_from_iter(args.iter()), row_to_build)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Archive a saved lot and return its slots to the pool.
///
/// Archiving is not deletion: the row stays, and slots go back to `available` rather than
/// having their state row removed.
#[tauri::command]
pub async fn archive_lot_build(build_id: String, archived: bool) -> Result<(), String> {
    let build = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
            .map_err(|e| e.to_string())?
    };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_build SET archived = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![build_id, archived as i64, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_build",
        &build_id,
        cols(vec![
            ("archived", serde_json::json!(archived as i64)),
            ("updated_at", serde_json::json!(chrono::Utc::now().to_rfc3339())),
        ]),
    );
    if archived {
        // Only slots this lot staged go back — a slot already taken off the master list
        // stays off it. Read them by name first, so each one can be replicated.
        let now = chrono::Utc::now().to_rfc3339();
        let freed: Vec<(String, String)> = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            let mut st = conn
                .prepare(
                    "SELECT sheet_id, location_code FROM lot_slot_state \
                     WHERE lot_id = ?1 AND state = 'staged'",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([&build_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE lot_slot_state SET state = 'available', lot_id = NULL, updated_at = ?2 \
                 WHERE lot_id = ?1 AND state = 'staged'",
                rusqlite::params![build_id, now],
            )
            .map_err(|e| e.to_string())?;
        }
        for (sheet_id, loc) in &freed {
            emit_slot(sheet_id, loc, "available", None, &now);
        }
    } else {
        set_lot_slot_state(
            build.sheet_id.clone(),
            build.slots.clone(),
            "staged".into(),
            Some(build_id),
            None,
        )
        .await?;
    }
    Ok(())
}

/// Take a saved lot's slots off the master list for good.
///
/// The deliberate half of the rule. Staging keeps a slot out of the pool while a lot is
/// being negotiated and is reversible; this says the stock has physically left, and a
/// removed code stays removed even when a later export no longer lists it — absent means
/// shipped, not undone. Nothing is deleted: the state row is updated in place.
#[tauri::command]
pub async fn remove_lot_from_master_list(
    build_id: String,
    removed: bool,
) -> Result<usize, String> {
    let build = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
            .map_err(|e| e.to_string())?
    };
    let state = if removed { "removed" } else { "staged" };
    let n = set_lot_slot_state(
        build.sheet_id.clone(),
        build.slots.clone(),
        state.into(),
        Some(build_id.clone()),
        Some(if removed {
            "removed from the master list".into()
        } else {
            "returned to the lot".into()
        }),
    )
    .await?;
    let now = chrono::Utc::now().to_rfc3339();
    let status = if removed { "sent" } else { "saved" };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_build SET status = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![build_id, status, now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(
        "lot_build",
        &build_id,
        cols(vec![
            ("status", serde_json::json!(status)),
            ("updated_at", serde_json::json!(now)),
        ]),
    );
    Ok(n)
}

// ---------------------------------------------------------------------------------------
// Commands — exports
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub rows: usize,
    /// True when the manifest, brand counts and pull sheet agree on the unit total.
    pub reconciled: bool,
}

/// Write one of the three artifacts to disk as CSV.
///
/// `kind` is `manifest`, `brands` or `pull`. All three are generated every time so the
/// reconciliation assertion can run — an export that does not agree with its siblings is
/// reported rather than quietly handed to a buyer.
///
/// `format` is `csv` (default) or `xlsx`. Both render the same `Doc`, so the two files carry
/// the same columns and the same totals — see `lot_engine::export`.
///
/// `dest_path` is a complete destination path from the caller's own save dialog, and beats
/// `dest_dir` when both are given: the point of asking a person where to put the file is to
/// put it there, not next to it.
#[tauri::command]
pub async fn export_lot_build(
    build_id: String,
    kind: String,
    include_slots: Option<bool>,
    dest_dir: Option<String>,
    format: Option<String>,
    dest_path: Option<String>,
) -> Result<ExportResult, String> {
    let detail = lot_build_detail(build_id.clone()).await?;
    let lot = build_stacks(&detail.build)?;
    let pricing = pricing_with_cost(
        detail.build.price_pct,
        detail.build.price_pct_json.as_deref(),
        detail.build.cost_pct,
        detail.build.cost_pct_json.as_deref(),
    );

    let opts = ManifestOpts {
        lot_name: detail.build.name.clone(),
        include_slots: include_slots.unwrap_or(saved_manifest_opts().include_slots),
        ..saved_manifest_opts()
    };
    let m = export::manifest(&lot, &pricing, &opts);
    let b = export::brand_counts(&lot, &pricing, &detail.build.name);
    let p = export::pull_sheet(&lot, &pricing, &detail.build.name);
    let reconciled = export::reconcile(&m, &b, &p, detail.totals.units).is_ok();

    let doc = match kind.as_str() {
        "manifest" => &m,
        "brands" => &b,
        "pull" => &p,
        other => return Err(format!("{other:?} is not one of manifest, brands or pull")),
    };

    let safe: String = detail
        .build
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let xlsx = matches!(format.as_deref(), Some("xlsx"));
    let ext = if xlsx { "xlsx" } else { "csv" };
    let path = match dest_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => {
            let dir = match dest_dir {
                Some(d) if !d.trim().is_empty() => PathBuf::from(d),
                _ => sheet_dir(&detail.build.sheet_id)?.join("lots"),
            };
            dir.join(format!("{safe}-{kind}.{ext}"))
        }
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if xlsx {
        let bytes = export::to_xlsx(doc).map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    } else {
        std::fs::write(&path, export::to_csv(doc)).map_err(|e| e.to_string())?;
    }

    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        rows: doc.sections.last().map(|s| s.rows.len()).unwrap_or(0),
        reconciled,
    })
}

/// The bare list of slot codes, in walk order, for pasting into a message to the floor.
#[tauri::command]
pub async fn lot_build_location_codes(build_id: String) -> Result<String, String> {
    Ok(lot_build_detail(build_id).await?.location_codes)
}

// ---------------------------------------------------------------------------------------
// Commands — conflicts
// ---------------------------------------------------------------------------------------

/// Because nothing is merged, the app owes the user a way to see what a barcode means.
#[tauri::command]
pub async fn lot_sheet_conflicts(
    sheet_id: String,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<crate::lot_engine::model::UpcConflict>, String> {
    // Recomputed from the stacks rather than stored twice, so it can never disagree with
    // the data the ranking uses.
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let conflicts = crate::lot_engine::pipeline::conflicts_of(&stacks);
    let q = query.unwrap_or_default().to_ascii_lowercase();
    let mut out: Vec<_> = conflicts
        .into_iter()
        .filter(|c| {
            q.is_empty()
                || c.upc.to_ascii_lowercase().contains(&q)
                || c.names.iter().any(|n| {
                    n.title.to_ascii_lowercase().contains(&q)
                        || n.brand
                            .as_deref()
                            .map(|b| b.to_ascii_lowercase().contains(&q))
                            .unwrap_or(false)
                })
        })
        .collect();
    out.truncate(limit.unwrap_or(200));
    Ok(out)
}

/// Write the barcode-conflict list to disk as CSV.
///
/// The screen shows the list; this is the copy that leaves the app. The 38 genuinely split
/// barcodes on the reference export cannot be resolved by software — they can only be
/// handed back to the warehouse as a list, which is the thing that actually fixes them.
///
/// Rebuilt from the stacks rather than read from the file written at import, so a sheet
/// that arrived over sync exports the same list as the one it was imported on.
///
/// `reconciled` on the result has no meaning here — there are no sibling artifacts for this
/// file to agree with — and nothing reads it for this kind.
#[tauri::command]
pub async fn export_lot_conflicts(
    sheet_id: String,
    dest_dir: Option<String>,
) -> Result<ExportResult, String> {
    ensure_artifact(&sheet_id).await?;
    let stacks = stacks_of(&sheet_id)?;
    let conflicts = crate::lot_engine::pipeline::conflicts_of(&stacks);
    let rows: usize = conflicts.iter().map(|c| c.names.len()).sum();

    let dir = match dest_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => sheet_dir(&sheet_id)?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(CONFLICTS_FILE);
    std::fs::write(&path, crate::lot_engine::report::conflicts_csv_of(&conflicts))
        .map_err(|e| e.to_string())?;

    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        rows,
        reconciled: true,
    })
}

/// Re-emit every lot engine row this device holds, so they replicate again.
///
/// The escape hatch for one specific ordering failure. A push for a table the server does
/// not yet accept is REJECTED, and `push_pending` treats a rejection as an acknowledgement
/// and drops the event — so a desktop that shipped before the server was updated would hold
/// sheets that exist here and nowhere else, with nothing left in the queue to retry. This
/// puts them all back on the wire.
///
/// Idempotent: the far side applies per-column last-writer-wins, so re-emitting a row that
/// already replicated changes nothing. Safe to run whenever a device looks out of step.
#[tauri::command]
pub async fn resync_lot_engine() -> Result<usize, String> {
    #[allow(clippy::type_complexity)]
    let (sheets, slots, builds): (Vec<String>, Vec<String>, Vec<String>) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let ids = |sql: &str| -> Result<Vec<String>, String> {
            let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        };
        (
            ids("SELECT id FROM lot_sheet")?,
            ids("SELECT id FROM lot_slot_state")?,
            ids("SELECT id FROM lot_build")?,
        )
    };

    let mut n = 0usize;
    for (table, ids) in [
        ("lot_sheet", &sheets),
        ("lot_slot_state", &slots),
        ("lot_build", &builds),
    ] {
        for id in ids {
            // The whole row, read back out, rather than a remembered column set — a
            // re-emit that carried fewer columns than the row has would quietly clear them
            // on every peer.
            let cols = match row_columns(table, id) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("lot engine resync: skipping {table}/{id}: {e}");
                    continue;
                }
            };
            emit(table, id, cols);
            n += 1;
        }
    }
    // The rows are only half of it: a sheet without its stacks is a summary nobody can rank
    // against. Re-queue every artifact this device holds.
    for id in &sheets {
        if has_artifact(id) {
            let rel_path = format!("lot-engine/{id}/{STACKS_FILE}");
            crate::netsync::media_enqueue(id, &rel_path, "lotsheet");
        }
    }
    tracing::info!("lot engine resync: re-emitted {n} rows and re-queued {} artifacts", sheets.len());
    Ok(n)
}

/// Rename a saved lot.
///
/// The name is what every export is filed under — `export_lot_build` builds the filename
/// from it — so renaming the lot renames its downloads, which is the point: the lot on
/// screen, the manifest in the buyer's inbox and the file on disk all say the same thing.
/// The sheet gained a rename in R-210; the lot did not, and its name was set once at save
/// and permanent after.
#[tauri::command]
pub async fn rename_lot_build(build_id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("a lot needs a name, and under 200 characters".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE lot_build SET name=?2, updated_at=?3 WHERE id=?1",
                rusqlite::params![build_id, name, now],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("that lot no longer exists".into());
        }
    }
    // Partial on purpose: the sync layer applies per column, so sending only what moved
    // cannot stamp a stale unit total over a fresher one from another device.
    let mut cols = serde_json::Map::new();
    cols.insert("name".into(), serde_json::Value::String(name));
    cols.insert("updated_at".into(), serde_json::Value::String(now));
    emit("lot_build", &build_id, cols);
    Ok(())
}

/// The settings key holding what a manifest shows. Org-shared, so two admins cannot send
/// the same buyer two differently-shaped documents — it is on the allowlist in
/// `netsync.rs` and in the server's `SHARED_SETTINGS_WHITELIST`.
const MANIFEST_OPTS_KEY: &str = "lot_manifest_opts";

/// What a manifest shows, as configured. Falls back to the defaults on a missing or
/// unreadable value rather than failing an export: a bad settings row must not stop a person
/// sending a buyer their paperwork.
fn saved_manifest_opts() -> ManifestOpts {
    let Ok(conn) = pool().get() else { return ManifestOpts::default() };
    conn.query_row(
        "SELECT value FROM settings WHERE key=?1",
        [MANIFEST_OPTS_KEY],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.trim().is_empty())
    .and_then(|s| serde_json::from_str::<ManifestOpts>(&s).ok())
    .unwrap_or_default()
}

#[tauri::command]
pub async fn get_lot_manifest_opts() -> Result<ManifestOpts, String> {
    Ok(saved_manifest_opts())
}

/// Set what every manifest shows. A hard rule for the document, not a per-export choice —
/// the point is that a column he does not want a buyer to see cannot come back by accident.
#[tauri::command]
pub async fn set_lot_manifest_opts(opts: ManifestOpts) -> Result<(), String> {
    let json = serde_json::to_string(&opts).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1,?2,?3) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        rusqlite::params![MANIFEST_OPTS_KEY, json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-price a saved lot: one percentage for every line in it, and optionally what it cost.
///
/// The percentage is set when a lot is built and was fixed after that, so a lot could not be
/// re-quoted without rebuilding it — and re-quoting is the normal thing to do, because the
/// number you send a buyer is the last thing you decide.
///
/// It re-reads the lot's stacks and recomputes through `lot_totals`, so `ask_total` and the
/// per-brand and per-category blocks move with it. It does NOT touch the slots, the staging
/// or the unit counts: nothing about what is in the lot changes, only what it is priced at.
#[tauri::command]
pub async fn reprice_lot_build(
    build_id: String,
    price_pct: f64,
    cost_pct: Option<f64>,
) -> Result<LotBuild, String> {
    if !price_pct.is_finite() || price_pct < 0.0 {
        return Err("a percentage of retail has to be a number, and not negative".into());
    }
    let build = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
            .map_err(|e| e.to_string())?
    };
    ensure_artifact(&build.sheet_id).await?;
    let lot = build_stacks(&build)?;

    // The per-category overrides are dropped on purpose: this sets ONE percentage across the
    // whole lot, which is the thing being asked for. A lot that wants different percentages
    // per category is edited on the Build tab, where that control lives.
    let pricing = pricing_with_cost(price_pct, None, cost_pct.unwrap_or(0.0), None);
    let t = lot_totals(&lot, &pricing);
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE lot_build SET price_pct=?2, price_pct_json=NULL, cost_pct=?3, \
             cost_pct_json=NULL, ask_total=?4, brands_json=?5, categories_json=?6, \
             updated_at=?7 WHERE id=?1",
            rusqlite::params![
                build_id,
                pricing.pct,
                pricing.cost_pct,
                t.ask,
                serde_json::to_string(&t.by_brand).ok(),
                serde_json::to_string(&t.by_category).ok(),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let mut cols = serde_json::Map::new();
    cols.insert("price_pct".into(), serde_json::json!(pricing.pct));
    cols.insert("price_pct_json".into(), serde_json::Value::Null);
    cols.insert("cost_pct".into(), serde_json::json!(pricing.cost_pct));
    cols.insert("cost_pct_json".into(), serde_json::Value::Null);
    cols.insert("ask_total".into(), serde_json::json!(t.ask));
    cols.insert("updated_at".into(), serde_json::Value::String(now));
    emit("lot_build", &build_id, cols);

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(&format!("{BUILD_SELECT} WHERE b.id = ?1"), [&build_id], row_to_build)
        .map_err(|e| e.to_string())
}

/// Re-emit ONE sheet — its row, every slot state and lot that belong to it, and its
/// stacks artifact — so it replicates again.
///
/// The narrow version of `resync_lot_engine`, and the one with a button, because the failure
/// it repairs is per sheet. A push for a table the server does not yet accept is **rejected,
/// and the rejection is treated as an acknowledgement**, so the event is dropped rather than
/// retried ([[revisit/00-BACKLOG]] #21b). Once that has happened to a sheet, nothing will
/// ever send it again on its own: the row sits here, correct and invisible, and the phone
/// shows an empty lot engine. That is exactly what happened to `Shoe list .xlsx` before the
/// server learned the three tables.
///
/// Idempotent. The far side applies per column and last-writer-wins, so re-sending a row
/// that already arrived changes nothing.
#[tauri::command]
pub async fn resync_lot_sheet(sheet_id: String) -> Result<usize, String> {
    #[allow(clippy::type_complexity)]
    let (slots, builds): (Vec<String>, Vec<String>) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let ids = |sql: &str| -> Result<Vec<String>, String> {
            let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = st
                .query_map([&sheet_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        };
        (
            ids("SELECT id FROM lot_slot_state WHERE sheet_id = ?1")?,
            ids("SELECT id FROM lot_build WHERE sheet_id = ?1")?,
        )
    };

    let mut n = 0usize;
    // The sheet row FIRST. A lot or a slot state that lands before its sheet is an orphan
    // on the far side — which is the state this device's two saved lots were already in.
    for (table, ids) in [
        ("lot_sheet", &vec![sheet_id.clone()]),
        ("lot_slot_state", &slots),
        ("lot_build", &builds),
    ] {
        for id in ids {
            let cols = match row_columns(table, id) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("lot sheet resync: skipping {table}/{id}: {e}");
                    continue;
                }
            };
            emit(table, id, cols);
            n += 1;
        }
    }
    // The rows are only half of it: a sheet without its stacks is a summary nobody can rank
    // against, and the phone says so rather than showing numbers it does not have.
    if has_artifact(&sheet_id) {
        let rel_path = format!("lot-engine/{sheet_id}/{STACKS_FILE}");
        crate::netsync::media_enqueue(&sheet_id, &rel_path, "lotsheet");
    }
    tracing::info!("lot sheet resync: re-emitted {n} rows for {sheet_id}");
    Ok(n)
}

/// Read one row back as a column map, so a re-emit carries everything the row has.
fn row_columns(
    table: &str,
    id: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    // `table` is one of three compile-time constants from the caller, never user input.
    let mut st = conn
        .prepare(&format!("SELECT * FROM {table} WHERE id = ?1"))
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = st.column_names().into_iter().map(|s| s.to_string()).collect();
    let mut rows = st.query([id]).map_err(|e| e.to_string())?;
    let row = rows
        .next()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "row vanished".to_string())?;
    let mut out = serde_json::Map::new();
    for (i, name) in names.iter().enumerate() {
        // `id` is the key, not a column to write; `org_id` is the server's to stamp.
        if name == "id" || name == "org_id" {
            continue;
        }
        let v = match row.get_ref(i).map_err(|e| e.to_string())? {
            rusqlite::types::ValueRef::Null => serde_json::Value::Null,
            rusqlite::types::ValueRef::Integer(n) => serde_json::json!(n),
            rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
            rusqlite::types::ValueRef::Text(t) => {
                serde_json::json!(String::from_utf8_lossy(t).to_string())
            }
            rusqlite::types::ValueRef::Blob(_) => continue,
        };
        out.insert(name.clone(), v);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::lot_engine::pipeline;
    use rust_xlsxwriter::Workbook;

    /// Reads a REAL `.xlsx` — written here, then parsed by the engine's own reader.
    ///
    /// Every other test in `lot_engine` feeds the pipeline a `Sheet` built in memory, which
    /// proves the arithmetic but not the file format. This one goes through calamine, the
    /// sheet picker, the header scan below junk rows, and the numeric-cell rendering that
    /// turns 250.0 back into "250" — the parts that only fail on a real workbook.
    #[test]
    fn a_real_xlsx_round_trips_through_the_reader() {
        let mut wb = Workbook::new();

        // Real exports carry a notes tab first. The reader must pick the one with the data.
        let notes = wb.add_worksheet();
        notes.set_name("Notes").unwrap();
        notes.write_string(0, 0, "Generated for the buyer").unwrap();

        let ws = wb.add_worksheet();
        ws.set_name("Inventory").unwrap();
        // Junk above the header, exactly as they arrive.
        ws.write_string(0, 0, "ACME WAREHOUSE").unwrap();
        ws.write_string(1, 0, "weekly export").unwrap();
        for (i, h) in ["UPC/EAN", "Location", "Box #", "Remaining", "Title", "MSRP"]
            .iter()
            .enumerate()
        {
            ws.write_string(3, i as u16, *h).unwrap();
        }
        let rows: [(&str, &str, &str, f64, &str, f64); 4] = [
            ("196969506827", "43-127-01B", "BOX3", 40.0, "Nike Air Max 90 Big Kid Shoes, Size 6.5", 190.0),
            ("196969506827", "4312701B", "BOX3", 20.0, "Nike Air Max 90 Big Kid Shoes, Size 6.5", 190.0),
            ("197968446084", "43-11O-03A", "", 380.0, "New Balance 9060 Big Kid Shoes, Size 6.5", 150.0),
            ("197968446084", "43-110-03A", "", 1.0, "New Balance 550 - Men's Size 12", 110.0),
        ];
        for (r, (upc, loc, bx, qty, title, msrp)) in rows.iter().enumerate() {
            let row = 4 + r as u32;
            // The barcode goes in as TEXT. Written as a number it would come back in
            // scientific notation and lose its identity.
            ws.write_string(row, 0, *upc).unwrap();
            ws.write_string(row, 1, *loc).unwrap();
            ws.write_string(row, 2, *bx).unwrap();
            ws.write_number(row, 3, *qty).unwrap();
            ws.write_string(row, 4, *title).unwrap();
            ws.write_number(row, 5, *msrp).unwrap();
        }

        let path = std::env::temp_dir().join("ecliptr-lot-engine-test.xlsx");
        wb.save(&path).unwrap();

        let r = pipeline::clean_path(&path.to_string_lossy()).unwrap();
        let _ = std::fs::remove_file(&path);

        // It read the data tab, not the notes tab.
        assert_eq!(r.detection.sheet.as_deref(), Some("Inventory"));
        assert_eq!(r.detection.format, "xlsx");
        assert_eq!(r.detection.header_row, 4);
        assert_eq!(r.detection.upc_col.as_deref(), Some("UPC/EAN"));

        // Two spellings of one shelf became one slot; the letter O became a zero.
        let mut locs: Vec<&str> = r.stacks.iter().map(|s| s.location.as_str()).collect();
        locs.sort();
        locs.dedup();
        assert_eq!(locs, vec!["43-110-03A", "43-127-01B"]);

        // The barcode survived as text, with all twelve digits.
        assert!(r.stacks.iter().all(|s| s.upc.len() == 12));

        // Rule two held through a real file: the 550 is still its own line.
        let nb: Vec<_> = r.stacks.iter().filter(|s| s.location == "43-110-03A").collect();
        assert_eq!(nb.len(), 2);

        assert_eq!(r.quality.units, 441);
        assert_eq!(r.quality.reconciliation_gap(), 0);

        // Stacks come out in walk order, so 43-110 precedes 43-127. Classification survived
        // the round trip on both shelves.
        assert_eq!(r.stacks[0].location, "43-110-03A");
        assert_eq!(r.stacks[0].brand.as_deref(), Some("New Balance"));
        let nike = r.stacks.iter().find(|s| s.location == "43-127-01B").unwrap();
        assert_eq!(nike.brand.as_deref(), Some("Nike"));
        assert_eq!(nike.units, 60, "two spellings of one shelf, one product, 40 + 20");
        assert_eq!(nike.size_us, Some(6.5));
    }
}
