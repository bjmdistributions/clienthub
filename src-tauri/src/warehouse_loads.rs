//! A delivery coming in, and every case received onto its pallets (R-519).
//!
//! One `warehouse_loads` row per delivery, its manifest as read in `lines_json`, and one
//! `warehouse_cases` row per case, so two devices receiving at once never overwrite each other.
//! Reading a manifest, checking a case and every count are `case_core.rs`, byte-identical on
//! the server (clienthub-api `routes/case_core.rs`, behind `routes/warehouse_loads.rs`): this
//! file is only storage, sync and the Tauri commands. Removed rows are archived, never deleted.

use crate::case_core::{self as core, Case, CaseLine, ItemCode, LoadLine, Out, PalletRecord, PalletView, Stock, Tally, TakeShort, Totals};
use crate::db::pool;
use std::collections::BTreeMap;
use crate::floor_core::{self as floor, FloorPallet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const LOADS: &str = "warehouse_loads";
const CASES: &str = "warehouse_cases";
const OUTS: &str = "warehouse_load_outs";
const PALLETS: &str = "warehouse_load_pallets";
/// R-568: the company's barcodes, each matched once to a brand, style, colour and size.
const CODES: &str = "item_codes";

#[derive(Debug, Serialize)]
pub struct LoadHead {
    pub id: String,
    pub name: String,
    pub source: String,
    pub notes: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    /// R-568: "units" when the delivery counts units, else pairs ("" or "pairs").
    pub unit: String,
    /// Left out when a case is saved (the lines did not change).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<LoadLine>>,
}

#[derive(Debug, Serialize)]
pub struct LoadDetail {
    pub load: LoadHead,
    pub cases: Vec<Case>,
    pub tally: Tally,
    /// Every order that took pairs (R-519 phase 2), put-back ones included, newest first.
    pub outs: Vec<OutRow>,
    /// What is left: received less every live out.
    pub stock: Stock,
    /// What a take could not take (set by `take_load_pairs` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<Vec<TakeShort>>,
    /// Every pallet, recorded or known through its boxes (R-535).
    pub pallets: Vec<PalletView>,
    /// Locations used most recently on any delivery, for the quick choices.
    pub recent_locations: Vec<String>,
    /// The number of the pallet a start just made (`start_load_pallet` only, R-550).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<i64>,
}

/// An out as the screen sees it: the row, plus its invoice's state ("live", "voided",
/// "removed", "gone", or "" for a take with no invoice).
#[derive(Debug, Serialize)]
pub struct OutRow {
    #[serde(flatten)]
    pub out: Out,
    pub invoice_state: &'static str,
}

#[derive(Debug, Serialize)]
pub struct LoadSummary {
    pub id: String,
    pub name: String,
    pub source: String,
    pub notes: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub totals: Totals,
    /// R-568: "units" or pairs.
    pub unit: String,
}

pub(crate) struct LoadRow {
    pub(crate) head: LoadHead,
    lines: Vec<LoadLine>,
}

const LOAD_COLS: &str = "id, name, COALESCE(source,''), COALESCE(notes,''), COALESCE(lines_json,'[]'), COALESCE(archived,0), created_at, updated_at, COALESCE(unit,'')";

fn map_load(r: &rusqlite::Row) -> rusqlite::Result<LoadRow> {
    let lines: String = r.get(4)?;
    Ok(LoadRow {
        head: LoadHead {
            id: r.get(0)?,
            name: r.get(1)?,
            source: r.get(2)?,
            notes: r.get(3)?,
            archived: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
            unit: r.get(8)?,
            lines: None,
        },
        lines: serde_json::from_str(&lines).unwrap_or_default(),
    })
}

pub(crate) fn load(conn: &rusqlite::Connection, id: &str) -> Result<LoadRow, String> {
    conn.query_row(&format!("SELECT {LOAD_COLS} FROM warehouse_loads WHERE id = ?1"), [id], map_load)
        .map_err(|_| "That delivery is no longer there.".to_string())
}

pub(crate) fn cases(conn: &rusqlite::Connection, load_id: &str) -> Result<Vec<Case>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(pallet,1), COALESCE(number,1), COALESCE(contents_json,'[]'), COALESCE(notes,''), created_at, updated_at, COALESCE(kind,'box'), COALESCE(code,''), \
             COALESCE(unmatched_json,'{}') \
             FROM warehouse_cases WHERE load_id = ?1 AND COALESCE(archived,0) = 0 ORDER BY pallet, number, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([load_id], |r| {
            let contents: String = r.get(3)?;
            let unmatched: String = r.get(9)?;
            Ok(Case {
                id: r.get(0)?,
                pallet: r.get(1)?,
                number: r.get(2)?,
                contents: serde_json::from_str(&contents).unwrap_or_default(),
                notes: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                kind: r.get(7)?,
                code: r.get(8)?,
                unmatched: serde_json::from_str(&unmatched).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// A delivery's pallet records (R-535), not removed ones.
pub(crate) fn pallet_records(conn: &rusqlite::Connection, load_id: &str) -> Result<Vec<PalletRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(number,0), COALESCE(location,''), COALESCE(closed,0), COALESCE(note,''), created_at, updated_at, \
             COALESCE(layers,0), COALESCE(per_layer,0) FROM warehouse_load_pallets WHERE load_id = ?1 AND COALESCE(archived,0) = 0 ORDER BY number",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([load_id], |r| {
            Ok(PalletRecord {
                id: r.get(0)?,
                number: r.get(1)?,
                location: r.get(2)?,
                closed: r.get::<_, i64>(3)? != 0,
                note: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                layers: r.get(7)?,
                per_layer: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// The locations used most recently on any delivery, for the quick choices beside the field.
fn recent_locations(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT location FROM warehouse_load_pallets WHERE COALESCE(location,'') <> '' AND COALESCE(archived,0) = 0 \
         GROUP BY location ORDER BY MAX(updated_at) DESC LIMIT 12",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let out: Vec<String> = match stmt.query_map([], |r| r.get::<_, String>(0)) {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    };
    out
}

/// Where each of a delivery's pallet records says it stands, by pallet number (R-550): floor id, x, y
/// and turned. A pallet with no record (known only through its boxes) stands nowhere.
fn pallet_spots(conn: &rusqlite::Connection, load_id: &str) -> Result<std::collections::HashMap<i64, (String, f64, f64, bool)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(number,0), COALESCE(floor_id,''), COALESCE(x,0), COALESCE(y,0), COALESCE(turned,0) \
             FROM warehouse_load_pallets WHERE load_id = ?1 AND COALESCE(archived,0) = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([load_id], |r| Ok((r.get::<_, i64>(0)?, (r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?, r.get::<_, i64>(4)? != 0))))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Every pallet of every delivery that is not removed, placed on a floor plan or not (R-550): the
/// counts are what Deliveries shows (`pallet_views`), joined with the position on its row. Newest
/// delivery first, then pallet number. A pallet whose `floor_id` names a removed or unknown building
/// is still listed with that id: the screen counts it as not on the floor plan.
pub(crate) fn floor_pallets(conn: &rusqlite::Connection) -> Result<Vec<FloorPallet>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {LOAD_COLS} FROM warehouse_loads WHERE COALESCE(archived,0) = 0 ORDER BY created_at DESC, id"))
        .map_err(|e| e.to_string())?;
    let loads: Vec<LoadRow> = stmt.query_map([], map_load).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    let mut out = Vec::new();
    for l in loads {
        let id = l.head.id;
        let tally = core::tally(&l.lines, &cases(conn, &id)?);
        let spots = pallet_spots(conn, &id)?;
        for v in core::pallet_views(&pallet_records(conn, &id)?, &tally.pallets) {
            let (floor_id, x, y, turned) = spots.get(&v.pallet).cloned().unwrap_or_default();
            out.push(FloorPallet {
                id: core::pallet_id(&id, v.pallet),
                load_id: id.clone(),
                load_name: l.head.name.clone(),
                number: v.pallet,
                location: v.location,
                closed: v.closed,
                note: v.note,
                floor_id,
                x,
                y,
                turned,
                boxes: v.boxes,
                filled: v.filled,
                loose: v.loose,
                pairs: v.pairs,
                styles: v.styles,
                layers: v.layers,
                per_layer: v.per_layer,
            });
        }
    }
    Ok(out)
}

/// The columns of a new pallet record: only what a new pallet needs. Location, full and note are
/// left to the schema's defaults, so a create from a device that had not yet seen this pallet can
/// never blank a location another device set (last writer wins per column).
pub(crate) fn pallet_cols(load_id: &str, number: i64, t: &str) -> Map<String, Value> {
    let mut cols = Map::new();
    cols.insert("load_id".into(), json!(load_id));
    cols.insert("number".into(), json!(number));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    cols
}

/// Whether a pallet row exists at all, removed ones included (its id is fixed by its number).
pub(crate) fn pallet_row_exists(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row("SELECT COUNT(*) FROM warehouse_load_pallets WHERE id = ?1", [id], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
}

/// Where a pallet is to stand on a floor plan (R-550). An empty `floor_id` is off the floor plan.
pub(crate) struct Spot {
    pub(crate) floor_id: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) turned: bool,
}

impl Spot {
    fn off() -> Spot {
        Spot { floor_id: String::new(), x: 0.0, y: 0.0, turned: false }
    }
}

/// A spot checked before anything is written: the building must exist and not be removed, and the
/// spot is pulled inside its walls (`floor_core::clean_spot`). An empty `floor_id` takes the pallet
/// off the floor plan. Nothing refuses overlap: pallets may touch or stand over one another.
fn resolve_spot(conn: &rusqlite::Connection, floor_id: &str, x: Option<f64>, y: Option<f64>, turned: Option<bool>) -> Result<Spot, String> {
    let floor_id = floor_id.trim();
    if floor_id.is_empty() {
        return Ok(Spot::off());
    }
    let f = crate::warehouse_floors::floor(conn, floor_id)?;
    if f.archived {
        return Err("That building was removed.".into());
    }
    let (x, y) = match (x, y) {
        (Some(x), Some(y)) => (x, y),
        _ => return Err("Say where on the floor plan it stands.".into()),
    };
    let turned = turned.unwrap_or(false);
    let (x, y) = floor::clean_spot(f.width, f.depth, x, y, turned)?;
    Ok(Spot { floor_id: f.id, x, y, turned })
}

/// A place writes all four columns together, so one event moves a pallet and two phones moving two
/// pallets never overwrite each other.
pub(crate) fn put_spot(cols: &mut Map<String, Value>, s: &Spot) {
    cols.insert("floor_id".into(), json!(s.floor_id));
    cols.insert("x".into(), json!(s.x));
    cols.insert("y".into(), json!(s.y));
    cols.insert("turned".into(), json!(s.turned as i64));
}

/// Write a new pallet, or bring a removed one with that number back. A pallet started at a spot
/// carries all four placement columns, one started anywhere else carries none (see `pallet_cols`).
fn put_new_pallet(conn: &rusqlite::Connection, load_id: &str, number: i64, t: &str, spot: Option<&Spot>) -> Result<(), String> {
    let pid = core::pallet_id(load_id, number);
    if pallet_row_exists(conn, &pid) {
        let mut cols = Map::new();
        cols.insert("archived".into(), json!(0));
        cols.insert("updated_at".into(), json!(t));
        match spot {
            Some(s) => put_spot(&mut cols, s),
            // The number of a removed pallet is a new pallet: it does not stand where that one did.
            None if stands_on_a_floor(conn, &pid) => put_spot(&mut cols, &Spot::off()),
            None => {}
        }
        write(conn, PALLETS, &pid, cols, false)
    } else {
        let mut cols = pallet_cols(load_id, number, t);
        if let Some(s) = spot {
            put_spot(&mut cols, s);
        }
        write(conn, PALLETS, &pid, cols, true)
    }
}

/// Whether a pallet's row says it stands on a floor plan (removed or not).
fn stands_on_a_floor(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row("SELECT COALESCE(floor_id,'') <> '' FROM warehouse_load_pallets WHERE id = ?1", [id], |r| r.get::<_, bool>(0)).unwrap_or(false)
}

pub(crate) fn outs(conn: &rusqlite::Connection, load_id: &str) -> Result<Vec<Out>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(invoice_id,''), COALESCE(reference,''), COALESCE(note,''), COALESCE(takes_json,'[]'), COALESCE(pairs,0), \
             COALESCE(cost_total,0), COALESCE(undone,0), COALESCE(undone_at,''), created_at, updated_at \
             FROM warehouse_load_outs WHERE load_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([load_id], |r| {
            let takes: String = r.get(4)?;
            Ok(Out {
                id: r.get(0)?,
                invoice_id: r.get(1)?,
                reference: r.get(2)?,
                note: r.get(3)?,
                takes: serde_json::from_str(&takes).unwrap_or_default(),
                pairs: r.get(5)?,
                cost: r.get(6)?,
                undone: r.get::<_, i64>(7)? != 0,
                undone_at: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// A voided or removed invoice does not put pairs back: Put back does. The screen says which.
fn invoice_state(conn: &rusqlite::Connection, invoice_id: &str) -> &'static str {
    if invoice_id.is_empty() {
        return "";
    }
    match conn.query_row(
        "SELECT COALESCE(voided,0), COALESCE(archived,0) FROM invoices WHERE id = ?1",
        [invoice_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    ) {
        Ok((v, _)) if v != 0 => "voided",
        Ok((_, a)) if a != 0 => "removed",
        Ok(_) => "live",
        Err(_) => "gone",
    }
}

fn detail(conn: &rusqlite::Connection, id: &str, with_lines: bool) -> Result<LoadDetail, String> {
    let LoadRow { mut head, lines } = load(conn, id)?;
    let cs = cases(conn, id)?;
    let os = outs(conn, id)?;
    let tally = core::tally(&lines, &cs);
    let stock = core::stock(&lines, &cs, &os);
    if with_lines {
        head.lines = Some(lines);
    }
    let outs = os
        .into_iter()
        .map(|o| {
            let invoice_state = invoice_state(conn, &o.invoice_id);
            OutRow { out: o, invoice_state }
        })
        .collect();
    let pallets = core::pallet_views(&pallet_records(conn, id)?, &tally.pallets);
    Ok(LoadDetail { load: head, cases: cs, tally, outs, stock, short: None, pallets, recent_locations: recent_locations(conn), started: None })
}

fn json_str<T: Serialize>(v: &T) -> Value {
    Value::String(serde_json::to_string(v).unwrap_or_else(|_| "[]".into()))
}

fn to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Number(n) => n.as_i64().map(rusqlite::types::Value::Integer)
            .unwrap_or_else(|| rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))),
        Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
        _ => rusqlite::types::Value::Null,
    }
}

/// Write the columns and record them for sync.
pub(crate) fn write(conn: &rusqlite::Connection, table: &str, id: &str, cols: Map<String, Value>, create: bool) -> Result<(), String> {
    let keys: Vec<&String> = cols.keys().collect();
    let params: Vec<rusqlite::types::Value> = cols.values().map(to_sql).collect();
    if create {
        let sql = format!(
            "INSERT INTO {table} (id, {}) VALUES (?1, {})",
            keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "),
            (2..=keys.len() + 1).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
        );
        let mut all = vec![rusqlite::types::Value::Text(id.to_string())];
        all.extend(params);
        conn.execute(&sql, rusqlite::params_from_iter(all.iter())).map_err(|e| e.to_string())?;
    } else {
        let sets: Vec<String> = keys.iter().enumerate().map(|(i, k)| format!("{k}=?{}", i + 1)).collect();
        let sql = format!("UPDATE {table} SET {} WHERE id=?{}", sets.join(", "), keys.len() + 1);
        let mut all = params;
        all.push(rusqlite::types::Value::Text(id.to_string()));
        conn.execute(&sql, rusqlite::params_from_iter(all.iter())).map_err(|e| e.to_string())?;
    }
    crate::sync::record_upsert(table, id, cols).map_err(|e| e.to_string())
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// R-568: "units" or "pairs" as stored; anything else is pairs.
fn clean_unit(s: &str) -> &'static str {
    if s.trim().eq_ignore_ascii_case("units") {
        "units"
    } else {
        "pairs"
    }
}

/// R-568: the company's barcodes, newest first, one per barcode (two devices matching the same
/// barcode at once can leave two rows; the newest is the one that counts).
pub(crate) fn item_codes(conn: &rusqlite::Connection) -> Result<Vec<ItemCode>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(code,''), COALESCE(brand,''), COALESCE(style,''), COALESCE(color,''), COALESCE(color_name,''), \
             COALESCE(description,''), COALESCE(size,''), COALESCE(how,''), COALESCE(updated_at,'') \
             FROM item_codes WHERE COALESCE(archived,0) = 0 ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ItemCode {
                id: r.get(0)?,
                code: r.get(1)?,
                brand: r.get(2)?,
                style: r.get(3)?,
                color: r.get(4)?,
                color_name: r.get(5)?,
                description: r.get(6)?,
                size: r.get(7)?,
                how: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    Ok(rows.filter_map(|r| r.ok()).filter(|c| !c.code.is_empty() && seen.insert(c.code.clone())).collect())
}

/// R-568: a box id this device chose: a safe id no row has used, live or removed.
fn free_case_id(conn: &rusqlite::Connection, case_id: &str) -> Result<(), String> {
    if !core::safe_id(case_id) || case_id.len() > 64 {
        return Err("That box id cannot be used.".into());
    }
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM warehouse_cases WHERE id = ?1", [case_id], |r| r.get(0)).unwrap_or(0);
    if n > 0 {
        return Err("That box was removed.".into());
    }
    Ok(())
}

/// R-568: a new box's columns: an empty box, or one holding what was scanned into it.
#[allow(clippy::too_many_arguments)]
fn new_case_cols(load_id: &str, pallet: i64, number: i64, contents: &[CaseLine], unmatched: &BTreeMap<String, i64>, notes: &str, loose: bool, code: &str, t: &str) -> Map<String, Value> {
    let mut cols = Map::new();
    cols.insert("load_id".into(), json!(load_id));
    cols.insert("pallet".into(), json!(pallet));
    cols.insert("number".into(), json!(number));
    cols.insert("contents_json".into(), json_str(&contents));
    if !unmatched.is_empty() {
        cols.insert("unmatched_json".into(), json_str(unmatched));
    }
    cols.insert("notes".into(), json!(notes.trim()));
    cols.insert("kind".into(), json!(if loose { "loose" } else { "box" }));
    cols.insert("code".into(), json!(code));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    cols
}

// ---------------------------------------------------------------------------------------

/// Every delivery, newest first, with its totals.
#[tauri::command]
pub async fn list_warehouse_loads() -> Result<Vec<LoadSummary>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {LOAD_COLS} FROM warehouse_loads ORDER BY created_at DESC"))
        .map_err(|e| e.to_string())?;
    let rows: Vec<LoadRow> = stmt.query_map([], map_load).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    let mut out = Vec::new();
    for r in rows {
        let totals = core::tally(&r.lines, &cases(&conn, &r.head.id)?).totals;
        let h = r.head;
        out.push(LoadSummary { id: h.id, name: h.name, source: h.source, notes: h.notes, archived: h.archived, created_at: h.created_at, updated_at: h.updated_at, totals, unit: h.unit });
    }
    Ok(out)
}

/// A manifest read for the preview, with what each tab is and the pictures of a few of its
/// styles (R-537). Nothing is saved.
#[tauri::command]
pub async fn read_load_manifest(path: String) -> Result<Value, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the file: {e}"))?;
    let (read, pics) = core::read_manifest_file(&path, &bytes)?;
    let mut v = json!(read);
    v["previews"] = json!(core::previews(&read, &pics));
    Ok(v)
}

/// What putting a file's pictures on lines did: (line id, picture path) for each line given one,
/// the pictures whose style is not among the lines, and the pictures the file left out.
struct PicturesPut {
    put: Vec<(String, String)>,
    not_on_delivery: usize,
    left_out: usize,
}

/// R-537: a manifest file's pictures for these lines (`core::same_lines`: never a guess), written
/// beside the synced media, one file for each distinct picture, each queued for the server.
fn pictures_for(load_id: &str, lines: &[LoadLine], path: &str) -> Result<PicturesPut, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?;
    let (read, pics) = core::read_manifest_file(path, &bytes)?;
    let pairs = core::same_lines(lines, &read.lines);
    let base = crate::db::app_data_dir().join("sync");
    let mut written: Vec<(std::sync::Arc<Vec<u8>>, String)> = Vec::new();
    let mut put: Vec<(String, String)> = Vec::new();
    for (read_id, p) in &pics {
        let saved_id = match pairs.iter().find(|(r, _)| r == read_id) {
            Some((_, s)) => s.clone(),
            None => continue,
        };
        // One picture placed on many styles is one file.
        let rel = match written.iter().find(|(b, _)| b.as_slice() == p.bytes.as_slice()) {
            Some((_, rel)) => rel.clone(),
            None => {
                let rel = core::picture_rel(load_id, &saved_id, &p.bytes).ok_or("A line's id cannot name a picture.")?;
                let file = base.join(&rel);
                if let Some(dir) = file.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(&file, p.bytes.as_slice()).map_err(|e| e.to_string())?;
                crate::netsync::media_enqueue(load_id, &rel, "delivery");
                written.push((p.bytes.clone(), rel.clone()));
                rel
            }
        };
        put.push((saved_id, rel));
    }
    Ok(PicturesPut { not_on_delivery: pics.len() - put.len(), left_out: read.pictures_left_out, put })
}

fn pictures_json(p: &PicturesPut) -> Value {
    json!({ "on_lines": p.put.len(), "not_on_delivery": p.not_on_delivery, "left_out": p.left_out })
}

/// R-537: put the pictures in a manifest file on a saved delivery. Each picture beside a style in
/// the file goes on the same style of the delivery, is saved in the synced media folder, and the
/// upload queue takes it to the server for the phone. A line the file has no picture for keeps
/// the one it has.
#[tauri::command]
pub async fn add_load_pictures(load_id: String, path: String) -> Result<Value, String> {
    let saved = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let l = load(&conn, &load_id)?;
        if l.head.archived {
            return Err("This delivery was removed. Bring it back first.".into());
        }
        l.lines
    };
    // The files first; then the paths, on the lines as they are now.
    let got = pictures_for(&load_id, &saved, &path)?;
    let put = &got.put;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut lines = load(&conn, &load_id)?.lines;
    let mut changed = false;
    for (saved_id, rel) in put {
        if let Some(x) = lines.iter_mut().find(|x| x.id == *saved_id) {
            if x.image != *rel {
                x.image = rel.clone();
                changed = true;
            }
        }
    }
    if changed {
        let mut cols = Map::new();
        cols.insert("lines_json".into(), json_str(&lines));
        cols.insert("updated_at".into(), json!(now()));
        write(&conn, LOADS, &load_id, cols, false)?;
    }
    let mut v = serde_json::to_value(detail(&conn, &load_id, true)?).map_err(|e| e.to_string())?;
    v["pictures"] = pictures_json(&got);
    Ok(v)
}

/// R-537: what fetching a delivery's pictures did: how many arrived, and how many are still
/// missing (not on the server yet: the screen asks again later).
#[derive(Debug, Serialize)]
pub struct PicturesFetched {
    pub arrived: usize,
    pub missing: usize,
}

/// R-537: fetch the pictures of a delivery's lines this computer does not have yet (a phone or
/// another computer added them).
#[tauri::command]
pub async fn ensure_delivery_pictures(load_id: String) -> Result<PicturesFetched, String> {
    let rels: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        load(&conn, &load_id)?.lines.into_iter().map(|l| l.image).filter(|r| !r.is_empty() && core::clean_image(r) == *r).collect()
    };
    let base = crate::db::app_data_dir().join("sync");
    let mut missing: Vec<String> = rels.into_iter().filter(|r| !base.join(r).exists()).collect();
    missing.sort();
    missing.dedup();
    let mut got = 0;
    for chunk in missing.chunks(8) {
        let res = futures::future::join_all(chunk.iter().map(|r| crate::netsync::download_media(r))).await;
        got += res.iter().filter(|r| r.is_ok()).count();
    }
    Ok(PicturesFetched { arrived: got, missing: missing.len() - got })
}

#[tauri::command]
pub async fn get_warehouse_load(id: String) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    detail(&conn, &id, true)
}

/// R-568: `blank` makes a delivery received with no manifest, which may start with no lines, and
/// `unit` says whether it counts pairs (the default) or units.
#[tauri::command]
pub async fn create_warehouse_load(name: String, source: String, lines: Vec<LoadLine>, blank: Option<bool>, unit: Option<String>) -> Result<LoadDetail, String> {
    create(name, source, lines, None, blank.unwrap_or(false), unit).map(|(d, _)| d)
}

/// R-537: a new delivery with its manifest's pictures already on its lines, so the lines are
/// written (and synced) once. A picture that cannot be put on says why, and the delivery is saved
/// all the same.
#[tauri::command]
pub async fn create_load_with_pictures(name: String, source: String, lines: Vec<LoadLine>, path: String) -> Result<Value, String> {
    let (d, pics) = create(name, source, lines, Some(path), false, None)?;
    let mut v = serde_json::to_value(d).map_err(|e| e.to_string())?;
    match pics {
        Some(Ok(p)) => v["pictures"] = pictures_json(&p),
        Some(Err(e)) => v["pictures_error"] = json!(e),
        None => {}
    }
    Ok(v)
}

fn create(name: String, source: String, lines: Vec<LoadLine>, path: Option<String>, blank: bool, unit: Option<String>) -> Result<(LoadDetail, Option<Result<PicturesPut, String>>), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the delivery a name.".into());
    }
    let mut lines = if blank { core::clean_lines_or_none(lines)? } else { core::clean_lines(lines)? };
    let id = uuid::Uuid::new_v4().to_string();
    let pics = path.map(|p| pictures_for(&id, &lines, &p));
    if let Some(Ok(p)) = &pics {
        for (line_id, rel) in &p.put {
            if let Some(x) = lines.iter_mut().find(|x| x.id == *line_id) {
                x.image = rel.clone();
            }
        }
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let t = now();
    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("source".into(), json!(source.trim()));
    if let Some(u) = unit.as_deref().filter(|u| !u.trim().is_empty()) {
        cols.insert("unit".into(), json!(clean_unit(u)));
    }
    cols.insert("notes".into(), json!(""));
    cols.insert("lines_json".into(), json_str(&lines));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    write(&conn, LOADS, &id, cols, true)?;
    // R-535: pallet 1 stands empty, ready for the truck.
    write(&conn, PALLETS, &core::pallet_id(&id, 1), pallet_cols(&id, 1, &t), true)?;
    Ok((detail(&conn, &id, true)?, pics))
}

/// Rename a delivery, note it, remove it (archived, never deleted) or bring it back.
#[tauri::command]
pub async fn update_warehouse_load(id: String, name: Option<String>, notes: Option<String>, archived: Option<bool>, unit: Option<String>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    load(&conn, &id)?;
    let mut cols = Map::new();
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err("Give the delivery a name.".into());
        }
        cols.insert("name".into(), json!(n));
    }
    if let Some(n) = notes {
        cols.insert("notes".into(), json!(n.trim()));
    }
    if let Some(a) = archived {
        cols.insert("archived".into(), json!(a as i64));
    }
    if let Some(u) = unit {
        cols.insert("unit".into(), json!(clean_unit(&u)));
    }
    cols.insert("updated_at".into(), json!(now()));
    write(&conn, LOADS, &id, cols, false)?;
    detail(&conn, &id, true)
}

#[derive(Debug, Deserialize)]
pub struct NewLine {
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub msrp: f64,
    #[serde(default)]
    pub sizes: String,
}

/// A style that came off the truck but is not on the manifest.
#[tauri::command]
pub async fn add_warehouse_load_line(id: String, line: NewLine) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if line.style.trim().is_empty() {
        return Err("Type the style.".into());
    }
    let sizes = core::parse_sizes(&line.sizes);
    if sizes.is_empty() {
        return Err("Type its sizes, for example 6, 7, 8, 9.".into());
    }
    let l = load(&conn, &id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let mut lines = l.lines;
    lines.push(LoadLine {
        id: format!("h{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
        brand: line.brand,
        group: line.group,
        style: line.style,
        color: line.color,
        description: line.description,
        color_name: String::new(),
        cost: line.cost,
        msrp: line.msrp,
        sizes,
        sheet_total: 0,
        source: "Added by hand".into(),
        sheet: String::new(),
        image: String::new(),
        rows: vec![],
        sizes_row: 0,
    });
    let lines = core::clean_lines(lines)?;
    let mut cols = Map::new();
    cols.insert("lines_json".into(), json_str(&lines));
    cols.insert("updated_at".into(), json!(now()));
    write(&conn, LOADS, &id, cols, false)?;
    detail(&conn, &id, true)
}

/// Save a case: a new one (and as many identical copies as asked), or a change to one saved.
///
/// R-568, the receiving screen: `unmatched` is the units scanned whose barcode is not matched yet (a
/// change that does not send it leaves the box's as they are). With `create`, `case_id` names a box this
/// device chose: made when it is not here yet, changed when it is, and it may start empty. `next_id`
/// (Complete box) also makes the next box on the pallet, empty, so its code shows before it is written.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_warehouse_case(
    load_id: String,
    case_id: Option<String>,
    pallet: i64,
    contents: Vec<CaseLine>,
    notes: Option<String>,
    copies: Option<i64>,
    kind: Option<String>,
    code: Option<String>,
    unmatched: Option<BTreeMap<String, i64>>,
    create: Option<bool>,
    next_id: Option<String>,
) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if !(1..=999).contains(&pallet) {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    let copies = copies.unwrap_or(1);
    if !(1..=core::MAX_COPIES).contains(&copies) {
        return Err(format!("Save between 1 and {} cases at once.", core::MAX_COPIES));
    }
    let unmatched_sent = match &unmatched {
        Some(m) => Some(core::clean_unmatched(m)?),
        None => None,
    };
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let asked = contents;
    let notes = notes.unwrap_or_default().trim().to_string();
    let mut have = cases(&conn, &load_id)?;
    let t = now();
    let given = case_id.as_deref().filter(|s| !s.is_empty());
    let known = given.filter(|g| have.iter().any(|c| c.id == *g));
    if let (Some(g), None) = (given, known) {
        if !create.unwrap_or(false) {
            return Err("That case is no longer there.".into());
        }
        free_case_id(&conn, g)?;
    }
    match known {
        Some(cid) => {
            let old = have.iter().find(|c| c.id == cid).cloned().ok_or("That case is no longer there.")?;
            let unmatched = unmatched_sent.clone().unwrap_or_else(|| old.unmatched.clone());
            // R-554: a box that exists may be left empty (counted on, not filled yet). Loose items hold
            // something: a pair, or a unit waiting on its barcode (R-568).
            let contents = core::clean_filling(&l.lines, &asked)?;
            if old.is_loose() && contents.is_empty() && unmatched.is_empty() {
                return Err("Put at least one pair in the case.".into());
            }
            core::check_case_total(&contents, &unmatched)?;
            // Never fewer pairs than were already sold (R-519 phase 2).
            let after: Vec<Case> = have.iter().map(|c| if c.id == cid { Case { contents: contents.clone(), ..c.clone() } } else { c.clone() }).collect();
            let bad = core::newly_oversold(&l.lines, &have, &after, &outs(&conn, &load_id)?);
            if !bad.is_empty() {
                return Err(format!("More pairs were sold than this case would leave: {}. Put back that order first, or keep the pairs.", core::describe_oversold(&l.lines, &bad)));
            }
            let mut cols = Map::new();
            if old.pallet != pallet {
                cols.insert("pallet".into(), json!(pallet));
                cols.insert("number".into(), json!(if old.is_loose() { 0 } else { core::next_number(&have, pallet, cid) }));
            }
            cols.insert("contents_json".into(), json_str(&contents));
            if unmatched_sent.is_some() {
                cols.insert("unmatched_json".into(), json_str(&unmatched));
            }
            cols.insert("notes".into(), json!(notes));
            if let Some(code) = &code {
                if !old.is_loose() {
                    cols.insert("code".into(), json!(core::clean_code(code)));
                }
            }
            cols.insert("updated_at".into(), json!(t));
            write(&conn, CASES, cid, cols, false)?;
        }
        None => {
            let unmatched = unmatched_sent.clone().unwrap_or_default();
            // R-535: loose items on the pallet are one row with no box number.
            let loose = kind.as_deref() == Some("loose");
            // A new box holds something, a pair or a unit waiting on its barcode (R-568); a box this
            // device made for the receiving screen may start empty.
            let contents = core::clean_filling(&l.lines, &asked)?;
            if contents.is_empty() && unmatched.is_empty() && (loose || given.is_none()) {
                return Err("Put at least one pair in the case.".into());
            }
            core::check_case_total(&contents, &unmatched)?;
            // R-554: each box gets its code, the pallet's short name and its number, unless one was given.
            let loc = pallet_records(&conn, &load_id)?.into_iter().find(|r| r.number == pallet).map(|r| r.location).unwrap_or_default();
            let label = core::pallet_label(&loc, pallet);
            let copies = if given.is_some() { 1 } else { copies };
            let code_given = code.as_deref().map(core::clean_code).filter(|c| !c.is_empty() && copies == 1);
            for k in 0..(if loose { 1 } else { copies }) {
                let number = if loose { 0 } else { core::next_number(&have, pallet, "") };
                let code = if loose { String::new() } else { code_given.clone().unwrap_or_else(|| core::box_code(&label, number)) };
                let cid = match (k, given) {
                    (0, Some(g)) => g.to_string(),
                    _ => uuid::Uuid::new_v4().to_string(),
                };
                write(&conn, CASES, &cid, new_case_cols(&load_id, pallet, number, &contents, &unmatched, &notes, loose, &code, &t), true)?;
                have.push(Case { id: cid, pallet, number, kind: if loose { "loose".into() } else { "box".into() }, code, ..Default::default() });
            }
        }
    }
    // R-568: Complete box makes the next box, empty, so its code is on the screen first.
    if let Some(nid) = next_id.as_deref().filter(|s| !s.is_empty()) {
        if !have.iter().any(|c| c.id == nid) {
            free_case_id(&conn, nid)?;
            let loc = pallet_records(&conn, &load_id)?.into_iter().find(|r| r.number == pallet).map(|r| r.location).unwrap_or_default();
            let number = core::next_number(&have, pallet, "");
            let code = core::box_code(&core::pallet_label(&loc, pallet), number);
            write(&conn, CASES, nid, new_case_cols(&load_id, pallet, number, &[], &BTreeMap::new(), "", false, &code, &t), true)?;
        }
    }
    detail(&conn, &load_id, false)
}

/// A case taken off (archived, never deleted). The others keep their numbers: they may be
/// written on the boxes.
#[tauri::command]
pub async fn remove_warehouse_case(load_id: String, case_id: String) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let have = cases(&conn, &load_id)?;
    if !have.iter().any(|c| c.id == case_id) {
        return Err("That case is no longer there.".into());
    }
    // Never fewer pairs than were already sold (R-519 phase 2).
    let l = load(&conn, &load_id)?;
    let after: Vec<Case> = have.iter().filter(|c| c.id != case_id).cloned().collect();
    let bad = core::newly_oversold(&l.lines, &have, &after, &outs(&conn, &load_id)?);
    if !bad.is_empty() {
        return Err(format!("Pairs from this case were already sold: {}. Put back that order first.", core::describe_oversold(&l.lines, &bad)));
    }
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(1));
    cols.insert("updated_at".into(), json!(now()));
    write(&conn, CASES, &case_id, cols, false)?;
    detail(&conn, &load_id, false)
}

/// Pairs leave a delivery (R-519 phase 2): called once the invoice exists, with the pairs its
/// lines took. Each style and size as far as what is left goes; what could not be taken comes
/// back in `short`. One out per invoice and delivery, so a retry returns the out already
/// written instead of taking twice.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn take_load_pairs(load_id: String, invoice_id: Option<String>, reference: Option<String>, note: Option<String>, takes: Vec<CaseLine>, over: Option<bool>, pairs: Option<i64>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let invoice_id = invoice_id.unwrap_or_default().trim().to_string();
    let out_id = if invoice_id.is_empty() { uuid::Uuid::new_v4().to_string() } else { format!("out-{invoice_id}-{load_id}") };
    let l = load(&conn, &load_id)?;
    let os = outs(&conn, &load_id)?;
    if os.iter().any(|o| o.id == out_id) {
        let mut d = detail(&conn, &load_id, false)?;
        d.short = Some(vec![]);
        return Ok(d);
    }
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let cs = cases(&conn, &load_id)?;
    // R-565: an invoice linked by its pair count alone names no style.
    let count = takes.is_empty() && pairs.unwrap_or(0) > 0;
    if count && invoice_state(&conn, &invoice_id) != "live" {
        return Err("Choose an invoice that is still live to link.".into());
    }
    if count && pairs.unwrap_or(0) > 1_000_000 {
        return Err("That is more pairs than one order can take.".into());
    }
    // R-554: each pair from the box the pick plan names (the plan the Sell tab showed).
    let asked: Vec<core::Take> = takes.into_iter().map(|t| core::Take { line_id: t.line_id, size: t.size, pairs: t.pairs, case_id: String::new() }).collect();
    let (taken, short) = if count { (vec![], vec![]) } else { core::take(&l.lines, &cs, &pallet_records(&conn, &load_id)?, &os, &asked, over.unwrap_or(false))? };
    if !taken.is_empty() || count {
        let t = now();
        let mut cols = Map::new();
        cols.insert("load_id".into(), json!(load_id));
        cols.insert("invoice_id".into(), json!(invoice_id));
        cols.insert("reference".into(), json!(reference.unwrap_or_default().trim()));
        cols.insert("note".into(), json!(note.unwrap_or_default().trim()));
        cols.insert("pairs".into(), json!(if count { pairs.unwrap_or(0) } else { taken.iter().map(|x| x.pairs).sum::<i64>() }));
        cols.insert("cost_total".into(), json!(core::takes_cost(&l.lines, &taken)));
        cols.insert("takes_json".into(), json_str(&taken));
        cols.insert("undone".into(), json!(0));
        cols.insert("undone_at".into(), json!(""));
        cols.insert("created_at".into(), json!(t));
        cols.insert("updated_at".into(), json!(t));
        write(&conn, OUTS, &out_id, cols, true)?;
    }
    let mut d = detail(&conn, &load_id, false)?;
    d.short = Some(short);
    Ok(d)
}

/// R-554: the pick list for the pairs picked so far: which boxes to take, pallet by pallet in the
/// order they stand. Nothing is written; the order records this same plan when its invoice exists.
/// The server's twin is `POST /api/warehouse/loads/:id/plan`.
#[tauri::command]
pub async fn plan_load_pick(load_id: String, takes: Vec<CaseLine>) -> Result<core::Plan, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let l = load(&conn, &load_id)?;
    core::allocate(&l.lines, &cases(&conn, &load_id)?, &pallet_records(&conn, &load_id)?, &outs(&conn, &load_id)?, &takes)
}

/// R-554: a sold order's pick list, rebuilt from the boxes it recorded, each where it stands now.
/// The server's twin is `GET /api/warehouse/loads/:id/outs/:out_id/pick`.
#[tauri::command]
pub async fn load_out_pick(load_id: String, out_id: String) -> Result<core::Plan, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    load(&conn, &load_id)?;
    let o = outs(&conn, &load_id)?.into_iter().find(|o| o.id == out_id).ok_or("That order is no longer on this delivery.")?;
    Ok(core::out_pick(&cases(&conn, &load_id)?, &pallet_records(&conn, &load_id)?, &o))
}

/// Put back: the out's pairs are on the delivery again. A set-once flag, so two devices pressing
/// it agree, and the row stays as the record of the order.
#[tauri::command]
pub async fn undo_load_out(load_id: String, out_id: String) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let o = outs(&conn, &load_id)?.into_iter().find(|o| o.id == out_id).ok_or("That order is no longer on this delivery.")?;
    if !o.undone {
        let t = now();
        let mut cols = Map::new();
        cols.insert("undone".into(), json!(1));
        cols.insert("undone_at".into(), json!(t));
        cols.insert("updated_at".into(), json!(t));
        write(&conn, OUTS, &out_id, cols, false)?;
        // R-488: the order comes off the delivery's buy, and its cost share goes back.
        crate::warehouse_buys::stock_put_back("", &load_id, &o.invoice_id);
    }
    detail(&conn, &load_id, false)
}

/// Where a new pallet is to stand on a floor plan (R-550).
#[derive(Debug, Deserialize)]
pub struct Place {
    pub floor_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub turned: bool,
}

/// Start the next pallet, empty (R-535). Its number is one more than any pallet the delivery has.
/// With a `place` (R-550) it starts standing there: the spot is checked before anything is written,
/// and the answer carries the new pallet's number as `started`.
#[tauri::command]
pub async fn start_load_pallet(load_id: String, place: Option<Place>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let n = core::next_pallet(&pallet_records(&conn, &load_id)?, &cases(&conn, &load_id)?);
    if n > 999 {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    let spot = match place.filter(|p| !p.floor_id.trim().is_empty()) {
        Some(p) => Some(resolve_spot(&conn, &p.floor_id, Some(p.x), Some(p.y), Some(p.turned))?),
        None => None,
    };
    put_new_pallet(&conn, &load_id, n, &now(), spot.as_ref())?;
    let mut d = detail(&conn, &load_id, false)?;
    d.started = Some(n);
    Ok(d)
}

/// Where a pallet stands, its note, full or not (R-535). The record is made the first time any of
/// them is set; "Pallet full" can also start the next pallet. With a `floor_id` (R-550) it is placed
/// on that floor plan at `x`, `y` (feet, its top-left corner), `turned` or not, all four written
/// together, and an empty `floor_id` takes it off the floor plan.
#[tauri::command]
pub async fn save_load_pallet(load_id: String, number: i64, location: Option<String>, note: Option<String>, closed: Option<bool>, start_next: Option<bool>, archived: Option<bool>, floor_id: Option<String>, x: Option<f64>, y: Option<f64>, turned: Option<bool>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if !(1..=999).contains(&number) {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    // Same answers as the server for a placement half sent.
    let spot = match floor_id.as_deref() {
        Some(f) => Some(resolve_spot(&conn, f, x, y, turned)?),
        None if x.is_none() && y.is_none() && turned.is_none() => None,
        None => return Err("Say which building it stands in.".into()),
    };
    let t = now();
    let records = pallet_records(&conn, &load_id)?;
    let have = cases(&conn, &load_id)?;
    let pid = core::pallet_id(&load_id, number);
    let exists = pallet_row_exists(&conn, &pid);
    let start_next = start_next.unwrap_or(false) && core::should_start_next(&records, &have, number);
    let mut cols = if exists { Map::new() } else { pallet_cols(&load_id, number, &t) };
    if let Some(a) = archived {
        if a && have.iter().any(|c| c.pallet == number) {
            return Err(format!("Pallet {number} still has boxes or loose items on it. Move or remove them first."));
        }
        cols.insert("archived".into(), json!(a as i64));
    } else if exists && !records.iter().any(|r| r.number == number) {
        // A removed pallet that is written to again comes back.
        cols.insert("archived".into(), json!(0));
    }
    if let Some(loc) = location {
        cols.insert("location".into(), json!(core::clean_location(&loc)));
    }
    if let Some(n) = note {
        cols.insert("note".into(), json!(n.trim()));
    }
    if let Some(c) = closed {
        cols.insert("closed".into(), json!(c as i64));
    }
    if let Some(s) = &spot {
        put_spot(&mut cols, s);
    }
    cols.insert("updated_at".into(), json!(t));
    write(&conn, PALLETS, &pid, cols, !exists)?;
    if start_next {
        let n = core::next_pallet(&pallet_records(&conn, &load_id)?, &have);
        if n <= 999 {
            put_new_pallet(&conn, &load_id, n, &t, None)?;
        }
    }
    detail(&conn, &load_id, false)
}

/// R-554: say how a pallet's boxes stack (rows stacked up, boxes in each row) and make its empty boxes,
/// each with its code (the pallet's short name and the box's number), until it has `count` (every row
/// full when not given). A box already on it with no code gets one. The record is made if there is
/// none. Never fewer boxes than are on it. The server's twin is `POST .../pallets/:number/boxes`.
#[tauri::command]
pub async fn set_pallet_boxes(load_id: String, number: i64, rows: i64, per_row: i64, count: Option<i64>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if !(1..=999).contains(&number) {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let records = pallet_records(&conn, &load_id)?;
    let mut have = cases(&conn, &load_id)?;
    let rec = records.iter().find(|r| r.number == number);
    if rec.is_none() && !have.iter().any(|c| c.pallet == number) {
        return Err(format!("There is no pallet {number} on this delivery."));
    }
    let label = core::pallet_label(rec.map(|r| r.location.as_str()).unwrap_or(""), number);
    let on: Vec<Case> = have.iter().filter(|c| c.pallet == number && !c.is_loose()).cloned().collect();
    // R-568: rows and boxes per row both 0 number `count` boxes ahead by the count alone.
    let by_count = rows == 0 && per_row == 0;
    let count = count.unwrap_or(rows * per_row);
    if by_count {
        core::check_box_count(&label, count, on.len())?;
    } else {
        core::check_box_setup(&label, rows, per_row, count, on.len())?;
    }
    let t = now();
    let pid = core::pallet_id(&load_id, number);
    let exists = pallet_row_exists(&conn, &pid);
    let mut cols = if exists { Map::new() } else { pallet_cols(&load_id, number, &t) };
    if exists && rec.is_none() {
        cols.insert("archived".into(), json!(0));
    }
    if !by_count {
        cols.insert("layers".into(), json!(rows));
        cols.insert("per_layer".into(), json!(per_row));
    }
    cols.insert("updated_at".into(), json!(t));
    write(&conn, PALLETS, &pid, cols, !exists)?;
    for c in on.iter().filter(|c| c.code.is_empty()) {
        let mut cols = Map::new();
        cols.insert("code".into(), json!(core::box_code(&label, c.number)));
        cols.insert("updated_at".into(), json!(t));
        write(&conn, CASES, &c.id, cols, false)?;
    }
    for _ in on.len()..(count as usize) {
        let n = core::next_number(&have, number, "");
        let cid = uuid::Uuid::new_v4().to_string();
        let code = core::box_code(&label, n);
        let mut cols = Map::new();
        cols.insert("load_id".into(), json!(load_id));
        cols.insert("pallet".into(), json!(number));
        cols.insert("number".into(), json!(n));
        cols.insert("contents_json".into(), json!("[]"));
        cols.insert("notes".into(), json!(""));
        cols.insert("kind".into(), json!("box"));
        cols.insert("code".into(), json!(code));
        cols.insert("archived".into(), json!(0));
        cols.insert("created_at".into(), json!(t));
        cols.insert("updated_at".into(), json!(t));
        write(&conn, CASES, &cid, cols, true)?;
        have.push(Case { id: cid, pallet: number, number: n, kind: "box".into(), code, ..Default::default() });
    }
    detail(&conn, &load_id, false)
}

/// R-568: every barcode the company knows, as it lands on this delivery (its line and size, or none),
/// so the receiving screen looks a scan up at once.
#[tauri::command]
pub async fn get_load_codes(load_id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let l = load(&conn, &load_id)?;
    Ok(json!({ "codes": core::resolve_codes(&l.lines, &item_codes(&conn)?) }))
}

/// R-568: match a barcode once. The company remembers it (`item_codes`), and every unit of it waiting
/// in any box of this delivery moves to that style and size in one go. Sent again, it changes nothing.
/// `line_id` and `size` name a line of this delivery; or `item` says what it is, added as a size or a
/// line "Added by scan" when the delivery does not list it. The server's twin is `POST .../match`.
#[tauri::command]
pub async fn match_load_code(load_id: String, code: String, line_id: Option<String>, size: Option<String>, item: Option<ItemCode>) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let code = core::clean_barcode(&code)?;
    let t = now();
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let mut lines = l.lines;
    let (line_id, size, item) = match (line_id.as_deref().filter(|s| !s.is_empty()), item) {
        (Some(lid), _) => {
            let line = lines.iter().find(|x| x.id == lid).ok_or("That style is no longer on the delivery.")?;
            let asked = size.unwrap_or_default();
            let size = core::line_size(line, &asked).ok_or_else(|| format!("{} {} has no size {}.", line.style, line.color, asked.trim()))?;
            let item = ItemCode {
                code: code.clone(),
                brand: line.brand.clone(),
                style: line.style.clone(),
                color: line.color.clone(),
                color_name: line.color_name.clone(),
                description: line.description.clone(),
                size: size.clone(),
                how: "matched".into(),
                ..Default::default()
            };
            (lid.to_string(), size, item)
        }
        (None, Some(mut item)) => {
            item.code = code.clone();
            item.how = "matched".into();
            let new_id = format!("s{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
            let (lid, size, changed) = core::place_item(&mut lines, &item, &new_id)?;
            if changed {
                lines = core::clean_lines_or_none(lines)?;
                let mut cols = Map::new();
                cols.insert("lines_json".into(), json_str(&lines));
                cols.insert("updated_at".into(), json!(t));
                write(&conn, LOADS, &load_id, cols, false)?;
            }
            item.size = size.clone();
            (lid, size, item)
        }
        (None, None) => return Err("Pick the style and size this barcode is.".into()),
    };
    // The company's barcode: one row per barcode, changed when it is matched again.
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM item_codes WHERE code = ?1 AND COALESCE(archived,0) = 0 ORDER BY updated_at DESC LIMIT 1",
            [&code],
            |r| r.get(0),
        )
        .ok();
    let create = found.is_none();
    let cid = found.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut cols = Map::new();
    for (k, v) in [
        ("code", &item.code),
        ("brand", &item.brand),
        ("style", &item.style),
        ("color", &item.color),
        ("color_name", &item.color_name),
        ("description", &item.description),
        ("size", &item.size),
        ("how", &item.how),
    ] {
        cols.insert(k.into(), json!(v.trim()));
    }
    cols.insert("archived".into(), json!(0));
    if create {
        cols.insert("created_at".into(), json!(t));
    }
    cols.insert("updated_at".into(), json!(t));
    write(&conn, CODES, &cid, cols, create)?;
    // Every unit of it waiting in a box moves to its style and size.
    let moved = core::match_cases(&cases(&conn, &load_id)?, &code, &line_id, &size);
    for c in &moved {
        core::check_case_total(&c.contents, &c.unmatched)?;
        let mut cols = Map::new();
        cols.insert("contents_json".into(), json_str(&c.contents));
        cols.insert("unmatched_json".into(), json_str(&c.unmatched));
        cols.insert("updated_at".into(), json!(t));
        write(&conn, CASES, &c.id, cols, false)?;
    }
    let mut v = serde_json::to_value(detail(&conn, &load_id, true)?).map_err(|e| e.to_string())?;
    v["resolved"] = json!(core::Resolved { code, line_id, size, item });
    v["boxes_moved"] = json!(moved.len());
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, style: &str, sizes: &[(&str, i64)]) -> LoadLine {
        LoadLine {
            id: id.into(),
            brand: "Acme".into(),
            style: style.into(),
            cost: 10.0,
            sizes: sizes.iter().map(|(s, q)| core::SizeQty { size: s.to_string(), qty: *q }).collect(),
            ..Default::default()
        }
    }

    /// R-568: receiving by scanning. A box made by this device (empty, its id chosen here), scans that
    /// land on lines and scans that wait on a match, Complete box making the next box, a save sent again
    /// landing once, and one match moving every waiting unit in every box.
    #[tokio::test]
    async fn boxes_are_scanned_and_a_barcode_is_matched_once() {
        let _db = crate::db::init_test_store();
        let id = create_warehouse_load("Lamo".into(), "l.xlsx".into(), vec![line("a", "MUM1913OA", &[("10", 8), ("11", 43)])], None, None).await.unwrap().load.id;
        // Opening the receiving screen makes box 1, empty, with an id this device chose.
        let d = save_warehouse_case(id.clone(), Some("rx-1".into()), 1, vec![], None, None, None, None, None, Some(true), None).await.unwrap();
        let b1 = d.cases.iter().find(|c| c.id == "rx-1").unwrap();
        assert_eq!((b1.number, b1.code.as_str(), b1.contents.len()), (1, "P1-1", 0));
        // Complete box: 2 pairs of size 11 known, 3 of a barcode not matched yet, and box 2 made.
        let mut waiting = BTreeMap::new();
        waiting.insert("883139385961".to_string(), 3);
        let c = vec![CaseLine { line_id: "a".into(), size: "11".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), Some("rx-1".into()), 1, c.clone(), None, None, None, None, Some(waiting.clone()), Some(true), Some("rx-2".into())).await.unwrap();
        // Sent again (a dropped answer): still one box 1 and one box 2.
        let d2 = save_warehouse_case(id.clone(), Some("rx-1".into()), 1, c, None, None, None, None, Some(waiting.clone()), Some(true), Some("rx-2".into())).await.unwrap();
        for d in [&d, &d2] {
            assert_eq!(d.cases.len(), 2);
            assert_eq!(d.tally.totals.received, 2);
            assert_eq!(d.tally.totals.unmatched, 3);
        }
        assert_eq!(d2.cases.iter().find(|c| c.id == "rx-2").unwrap().code, "P1-2");
        // Box 2 holds only unmatched units of the same barcode.
        save_warehouse_case(id.clone(), Some("rx-2".into()), 1, vec![], None, None, None, None, Some(waiting), Some(true), Some("rx-3".into())).await.unwrap();
        // A removed box's id is never taken again, and an unknown id without create is refused.
        assert!(save_warehouse_case(id.clone(), Some("nope".into()), 1, vec![], None, None, None, None, None, None, None).await.is_err());
        // Match it: every waiting unit, in both boxes, moves to size 11.
        let v = match_load_code(id.clone(), "0883139385961".into(), Some("a".into()), Some("11.0".into()), None).await.unwrap();
        assert_eq!(v["boxes_moved"], 2);
        assert_eq!(v["resolved"]["size"], "11");
        assert_eq!(v["tally"]["totals"]["received"], 8);
        assert_eq!(v["tally"]["totals"]["unmatched"], 0);
        // The company knows it now: the next scan of it lands without asking.
        let codes = get_load_codes(id.clone()).await.unwrap();
        assert_eq!(codes["codes"][0]["code"], "00883139385961");
        assert_eq!(codes["codes"][0]["line_id"], "a");
        // Matched again: nothing moves.
        let v = match_load_code(id.clone(), "883139385961".into(), Some("a".into()), Some("11".into()), None).await.unwrap();
        assert_eq!(v["boxes_moved"], 0);
        assert_eq!(item_codes(&pool().get().unwrap()).unwrap().len(), 1);
        // A delivery with no manifest: a matched item becomes its line, added by scan.
        let blank = create_warehouse_load("No sheet".into(), "".into(), vec![], Some(true), Some("units".into())).await.unwrap();
        assert_eq!(blank.load.unit, "units");
        let bid = blank.load.id;
        let mut w = BTreeMap::new();
        w.insert("SKU-RED-M".to_string(), 4);
        save_warehouse_case(bid.clone(), Some("rx-9".into()), 1, vec![], None, None, None, None, Some(w), Some(true), None).await.unwrap();
        let item = ItemCode { brand: "Acme".into(), style: "Tee".into(), color_name: "Red".into(), size: "M".into(), ..Default::default() };
        let v = match_load_code(bid.clone(), "SKU-RED-M".into(), None, None, Some(item)).await.unwrap();
        assert_eq!(v["load"]["lines"][0]["source"], "Added by scan");
        assert_eq!(v["tally"]["totals"]["received"], 4);
        // 27 boxes numbered ahead by the count alone, no rows asked.
        let d = set_pallet_boxes(bid.clone(), 1, 0, 0, Some(27)).await.unwrap();
        assert_eq!(d.cases.iter().filter(|c| c.pallet == 1 && !c.is_loose()).count(), 27);
        assert_eq!(d.pallets[0].layers, 0);
    }

    /// A delivery saved, cases added (three copies, one moved, one removed), a style added by
    /// hand, and every count read back from the stored rows.
    #[tokio::test]
    async fn a_delivery_receives_cases_onto_pallets() {
        let _db = crate::db::init_test_store();
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4), ("8", 2)]), line("b", "K2", &[("S", 3)])], None, None).await.unwrap();
        let id = d.load.id.clone();
        assert_eq!(d.tally.totals.expected, 9);
        let c = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }, CaseLine { line_id: "b".into(), size: "S".into(), pairs: 1 }];
        let d = save_warehouse_case(id.clone(), None, 1, c.clone(), None, Some(3), None, None, None, None, None).await.unwrap();
        assert!(d.load.lines.is_none());
        assert_eq!(d.cases.iter().map(|x| (x.pallet, x.number)).collect::<Vec<_>>(), vec![(1, 1), (1, 2), (1, 3)]);
        assert_eq!(d.tally.totals.received, 9);
        let moved = d.cases[1].id.clone();
        let d = save_warehouse_case(id.clone(), Some(moved.clone()), 2, c.clone(), Some("dented".into()), None, None, None, None, None, None).await.unwrap();
        let m = d.cases.iter().find(|x| x.id == moved).unwrap();
        assert_eq!((m.pallet, m.number, m.notes.as_str()), (2, 1, "dented"));
        let d = remove_warehouse_case(id.clone(), d.cases[0].id.clone()).await.unwrap();
        assert_eq!(d.cases.len(), 2);
        assert_eq!(d.tally.totals.received, 6);
        assert!(save_warehouse_case(id.clone(), None, 1, vec![CaseLine { line_id: "a".into(), size: "12".into(), pairs: 1 }], None, None, None, None, None, None, None).await.is_err());
        let d = add_warehouse_load_line(id.clone(), NewLine { style: "X9".into(), sizes: "5, 6".into(), brand: "Acme".into(), group: String::new(), color: String::new(), description: String::new(), cost: 0.0, msrp: 0.0 }).await.unwrap();
        assert_eq!(d.load.lines.as_ref().unwrap().len(), 3);
        let d = update_warehouse_load(id.clone(), None, None, Some(true), None).await.unwrap();
        assert!(d.load.archived);
        assert!(save_warehouse_case(id.clone(), None, 1, c, None, None, None, None, None, None, None).await.is_err());
        let all = list_warehouse_loads().await.unwrap();
        assert!(all.iter().any(|x| x.id == id && x.totals.cases == 2));
    }

    /// R-519 phase 2: an invoice's pairs leave the delivery once, a retry takes nothing twice,
    /// a case edit cannot undercut a sale, and Put back returns the pairs.
    #[tokio::test]
    async fn an_order_takes_pairs_once_and_put_back_returns_them() {
        let _db = crate::db::init_test_store();
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4), ("8", 2)])], None, None).await.unwrap();
        let id = d.load.id.clone();
        let c = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 3 }, CaseLine { line_id: "a".into(), size: "8".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), None, 1, c, None, None, None, None, None, None, None).await.unwrap();
        let case_id = d.cases[0].id.clone();
        assert_eq!(d.stock.left, 5);
        let want = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }, CaseLine { line_id: "a".into(), size: "8".into(), pairs: 5 }];
        let d = take_load_pairs(id.clone(), Some("inv1".into()), Some("INV-1".into()), None, want.clone(), None, None).await.unwrap();
        assert_eq!(d.stock.left, 1);
        assert_eq!(d.short.as_ref().unwrap().len(), 1);
        assert_eq!(d.outs.len(), 1);
        assert_eq!((d.outs[0].out.pairs, d.outs[0].out.cost, d.outs[0].invoice_state), (4, 40.0, "gone"));
        // The same invoice again takes nothing more.
        let d = take_load_pairs(id.clone(), Some("inv1".into()), Some("INV-1".into()), None, want, None, None).await.unwrap();
        assert_eq!((d.stock.left, d.outs.len()), (1, 1));
        // Cutting the case below what was sold is refused; so is removing it.
        let less = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 1 }];
        assert!(save_warehouse_case(id.clone(), Some(case_id.clone()), 1, less, None, None, None, None, None, None, None).await.is_err());
        assert!(remove_warehouse_case(id.clone(), case_id.clone()).await.is_err());
        let out_id = d.outs[0].out.id.clone();
        let d = undo_load_out(id.clone(), out_id.clone()).await.unwrap();
        assert_eq!(d.stock.left, 5);
        assert!(d.outs[0].out.undone);
        // A second Put back changes nothing; now the case can go.
        assert_eq!(undo_load_out(id.clone(), out_id).await.unwrap().stock.left, 5);
        assert!(remove_warehouse_case(id.clone(), case_id).await.is_ok());
    }

    /// R-535: a new delivery has pallet 1 standing empty; a pallet gets a location and is marked
    /// full, which starts the next; loose items take no box number.
    #[tokio::test]
    async fn pallets_are_records_with_locations_and_loose_items() {
        let _db = crate::db::init_test_store();
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4), ("8", 2)])], None, None).await.unwrap();
        let id = d.load.id.clone();
        assert_eq!(d.pallets.iter().map(|p| (p.pallet, p.recorded, p.pairs)).collect::<Vec<_>>(), vec![(1, true, 0)]);
        let loose = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), None, 1, loose, None, Some(5), Some("loose".into()), None, None, None, None).await.unwrap();
        assert_eq!(d.cases.len(), 1);
        assert_eq!((d.cases[0].number, d.cases[0].kind.as_str()), (0, "loose"));
        let boxed = vec![CaseLine { line_id: "a".into(), size: "8".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), None, 1, boxed, None, None, None, None, None, None, None).await.unwrap();
        let b = d.cases.iter().find(|c| !c.is_loose()).unwrap();
        assert_eq!(b.number, 1);
        assert_eq!((d.pallets[0].boxes, d.pallets[0].loose, d.pallets[0].pairs), (1, 2, 4));
        let d = save_load_pallet(id.clone(), 1, Some("  Dock door ".into()), None, Some(true), Some(true), None, None, None, None, None).await.unwrap();
        assert_eq!(d.pallets.iter().map(|p| (p.pallet, p.location.as_str(), p.closed)).collect::<Vec<_>>(), vec![(1, "Dock door", true), (2, "", false)]);
        assert_eq!(d.recent_locations, vec!["Dock door".to_string()]);
        // A second Pallet full on 1 (a retry) starts nothing more.
        let d = save_load_pallet(id.clone(), 1, None, None, Some(true), Some(true), None, None, None, None, None).await.unwrap();
        assert_eq!(d.pallets.len(), 2);
        let d = start_load_pallet(id.clone(), None).await.unwrap();
        assert_eq!(d.pallets.last().unwrap().pallet, 3);
        assert_eq!(d.tally.totals.cases, 1);
        // An empty pallet can be removed and its number comes back with the next start; one with boxes cannot.
        let d = save_load_pallet(id.clone(), 3, None, None, None, None, Some(true), None, None, None, None).await.unwrap();
        assert_eq!(d.pallets.len(), 2);
        assert!(save_load_pallet(id.clone(), 1, None, None, None, None, Some(true), None, None, None, None).await.is_err());
        let d = start_load_pallet(id.clone(), None).await.unwrap();
        assert_eq!(d.pallets.iter().map(|p| p.pallet).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    // ---- R-550: the floor plan --------------------------------------------------------------

    use crate::warehouse_floors::{change_pallet_row, create_warehouse_floor, draw_pallet_row, list_warehouse_floors, update_warehouse_floor};

    /// The columns of the last event written for a row, exactly as they were queued for sync.
    fn last_event(table: &str, row_id: &str) -> Map<String, Value> {
        let conn = pool().get().unwrap();
        let mut stmt = conn.prepare("SELECT event_json FROM netsync_outbound ORDER BY rowid DESC").unwrap();
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
        for j in rows {
            let v: Value = serde_json::from_str(&j).unwrap();
            if v["op"]["table"] == table && v["op"]["row_id"] == row_id {
                return v["op"]["columns"].as_object().unwrap().clone();
            }
        }
        panic!("no event for {table} {row_id}");
    }

    /// One pallet as the floor plan lists it.
    async fn on_plan(load_id: &str, number: i64) -> FloorPallet {
        list_warehouse_floors().await.unwrap().pallets.into_iter().find(|p| p.load_id == load_id && p.number == number).expect("pallet is listed")
    }

    const SPOT_COLS: [&str; 4] = ["floor_id", "x", "y", "turned"];

    /// A building is drawn, changed and removed: its size, doors and rooms are always cleaned, a
    /// create carries every column, and a change writes only what changed.
    #[tokio::test]
    async fn a_building_is_drawn_changed_and_removed() {
        let _db = crate::db::init_test_store();
        assert!(create_warehouse_floor("Main".into(), 5.0, 60.0, None).await.is_err());
        let shape = floor::FloorShape {
            doors: vec![floor::Door { side: "top".into(), at: 95.0, width: 12.0, kind: "garage".into(), ..Default::default() }],
            areas: vec![floor::Area { kind: "office".into(), x: 90.0, y: 50.0, w: 15.0, d: 12.0, ..Default::default() }],
        };
        let f = create_warehouse_floor("  Main\n building ".into(), 100.0, 60.0, Some(shape)).await.unwrap().floor;
        assert!(f.id.starts_with("flr-"));
        assert_eq!((f.name.as_str(), f.width, f.depth, f.archived), ("Main building", 100.0, 60.0, false));
        // The garage door and the office are pulled inside the walls.
        assert_eq!((f.shape.doors[0].at, f.shape.areas[0].x, f.shape.areas[0].y, f.shape.areas[0].label.as_str()), (88.0, 85.0, 48.0, "Office"));
        let ev = last_event("warehouse_floors", &f.id);
        for k in ["name", "width", "depth", "shape_json", "archived", "created_at", "updated_at"] {
            assert!(ev.contains_key(k), "a create event carries {k}");
        }
        // Shrinking pulls the door and the room inside the new walls, and writes only what changed.
        let g = update_warehouse_floor(f.id.clone(), None, Some(60.0), None, None, None).await.unwrap().floor;
        assert_eq!((g.width, g.depth, g.name.as_str()), (60.0, 60.0, "Main building"));
        assert_eq!((g.shape.doors[0].at, g.shape.areas[0].x), (48.0, 45.0));
        let ev = last_event("warehouse_floors", &f.id);
        assert!(ev.contains_key("width") && ev.contains_key("shape_json") && ev.contains_key("updated_at"));
        assert!(!ev.contains_key("name") && !ev.contains_key("depth") && !ev.contains_key("archived"));
        // A size outside 10 to 1,000 ft is refused and changes nothing.
        assert!(update_warehouse_floor(f.id.clone(), None, Some(2000.0), None, None, None).await.is_err());
        assert!(update_warehouse_floor("flr-nope".into(), Some("x".into()), None, None, None, None).await.is_err());
        // Removed, still listed (with its flag), and brought back.
        let r = update_warehouse_floor(f.id.clone(), None, None, None, None, Some(true)).await.unwrap().floor;
        assert!(r.archived);
        assert!(list_warehouse_floors().await.unwrap().floors.iter().any(|x| x.id == f.id && x.archived));
        let r = update_warehouse_floor(f.id.clone(), None, None, None, None, Some(false)).await.unwrap().floor;
        assert!(!r.archived);
        assert_eq!(r.shape, g.shape);
    }

    /// A pallet is placed on a building (pulled inside the walls, turned, taken off), a removed or
    /// unknown building is refused before anything is written, a removed pallet placed again comes
    /// back, and a place is one event with all four columns.
    #[tokio::test]
    async fn a_pallet_is_placed_on_a_floor_plan() {
        let _db = crate::db::init_test_store();
        let fl = create_warehouse_floor("Main".into(), 100.0, 60.0, None).await.unwrap().floor;
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4)])], None, None).await.unwrap();
        let id = d.load.id.clone();
        let pid = core::pallet_id(&id, 1);
        // The pallet's own create carries no placement, so it can never blank one set elsewhere.
        let ev = last_event(PALLETS, &pid);
        assert!(!SPOT_COLS.iter().any(|k| ev.contains_key(*k)));
        assert_eq!(pallet_cols(&id, 1, "t").keys().filter(|k| SPOT_COLS.contains(&k.as_str())).count(), 0);
        assert_eq!(on_plan(&id, 1).await.floor_id, "");

        // Placed past the corner: pulled inside the walls, all four columns in one event.
        let place = |f: &str, x: f64, y: f64, turned: Option<bool>| save_load_pallet(id.clone(), 1, None, None, None, None, None, Some(f.to_string()), Some(x), Some(y), turned);
        place(&fl.id, 98.0, 59.0, None).await.unwrap();
        let p = on_plan(&id, 1).await;
        assert_eq!((p.floor_id.as_str(), p.x, p.y, p.turned), (fl.id.as_str(), 96.0, 56.67, false));
        let ev = last_event(PALLETS, &pid);
        assert_eq!(ev["floor_id"], json!(fl.id));
        assert_eq!((ev["x"].as_f64(), ev["y"].as_f64(), ev["turned"].as_i64()), (Some(96.0), Some(56.67), Some(0)));
        assert!(SPOT_COLS.iter().all(|k| ev.contains_key(*k)));
        // Turned: its footprint swaps, and it is kept inside the walls the other way round.
        place(&fl.id, 98.0, 59.0, Some(true)).await.unwrap();
        let p = on_plan(&id, 1).await;
        assert_eq!((p.x, p.y, p.turned), (96.67, 56.0, true));
        // Pallets may stand over one another: a second one on the same spot is not refused.
        let d = start_load_pallet(id.clone(), Some(Place { floor_id: fl.id.clone(), x: 96.67, y: 56.0, turned: true })).await.unwrap();
        assert_eq!(d.started, Some(2));
        assert_eq!((on_plan(&id, 2).await.x, on_plan(&id, 2).await.y), (96.67, 56.0));
        // Taken off the floor plan: all four written, blank.
        place("", 5.0, 5.0, Some(true)).await.unwrap();
        let p = on_plan(&id, 1).await;
        assert_eq!((p.floor_id.as_str(), p.x, p.y, p.turned), ("", 0.0, 0.0, false));
        let ev = last_event(PALLETS, &pid);
        assert_eq!((ev["floor_id"].as_str(), ev["x"].as_f64(), ev["y"].as_f64(), ev["turned"].as_i64()), (Some(""), Some(0.0), Some(0.0), Some(0)));

        // An unknown building, a spot with no position and a removed building are refused, and the
        // pallet stays where it was.
        place(&fl.id, 10.0, 10.0, None).await.unwrap();
        assert_eq!(place("flr-nope", 1.0, 1.0, None).await.unwrap_err(), "No such building.");
        let no_x = save_load_pallet(id.clone(), 1, None, None, None, None, None, Some(fl.id.clone()), None, Some(1.0), None).await;
        assert_eq!(no_x.unwrap_err(), "Say where on the floor plan it stands.");
        let no_floor = save_load_pallet(id.clone(), 1, None, None, None, None, None, None, Some(1.0), Some(1.0), None).await;
        assert_eq!(no_floor.unwrap_err(), "Say which building it stands in.");
        update_warehouse_floor(fl.id.clone(), None, None, None, None, Some(true)).await.unwrap();
        assert_eq!(place(&fl.id, 1.0, 1.0, None).await.unwrap_err(), "That building was removed.");
        let p = on_plan(&id, 1).await;
        assert_eq!((p.floor_id.as_str(), p.x, p.y), (fl.id.as_str(), 10.0, 10.0));
        update_warehouse_floor(fl.id.clone(), None, None, None, None, Some(false)).await.unwrap();

        // A removed pallet placed again comes back, standing there.
        save_load_pallet(id.clone(), 1, None, None, None, None, Some(true), None, None, None, None).await.unwrap();
        assert!(get_warehouse_load(id.clone()).await.unwrap().pallets.iter().all(|p| p.pallet != 1));
        place(&fl.id, 20.0, 20.0, None).await.unwrap();
        assert!(get_warehouse_load(id.clone()).await.unwrap().pallets.iter().any(|p| p.pallet == 1));
        assert_eq!((on_plan(&id, 1).await.x, on_plan(&id, 1).await.y), (20.0, 20.0));

        // A pallet known only through its boxes has no record: placing it makes one, in one create event.
        let boxed = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }];
        save_warehouse_case(id.clone(), None, 5, boxed, None, None, None, None, None, None, None).await.unwrap();
        assert_eq!(on_plan(&id, 5).await.floor_id, "");
        save_load_pallet(id.clone(), 5, None, None, None, None, None, Some(fl.id.clone()), Some(30.0), Some(30.0), Some(true)).await.unwrap();
        let ev = last_event(PALLETS, &core::pallet_id(&id, 5));
        assert!(["load_id", "number", "archived", "created_at", "updated_at"].iter().chain(SPOT_COLS.iter()).all(|k| ev.contains_key(*k)));
        let p = on_plan(&id, 5).await;
        assert_eq!((p.floor_id.as_str(), p.x, p.y, p.turned, p.boxes, p.pairs), (fl.id.as_str(), 30.0, 30.0, true, 1, 2));
    }

    /// A pallet started at a spot stands there from its first event, a refused spot writes nothing,
    /// and a pallet started anywhere else carries no placement (even on a removed pallet's number).
    #[tokio::test]
    async fn a_pallet_starts_on_the_floor_plan() {
        let _db = crate::db::init_test_store();
        let fl = create_warehouse_floor("Main".into(), 100.0, 60.0, None).await.unwrap().floor;
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4)])], None, None).await.unwrap();
        let id = d.load.id.clone();
        let d = start_load_pallet(id.clone(), Some(Place { floor_id: fl.id.clone(), x: 10.0, y: 10.0, turned: true })).await.unwrap();
        assert_eq!(d.started, Some(2));
        assert_eq!(d.pallets.iter().map(|p| p.pallet).collect::<Vec<_>>(), vec![1, 2]);
        let p = on_plan(&id, 2).await;
        assert_eq!((p.floor_id.as_str(), p.x, p.y, p.turned), (fl.id.as_str(), 10.0, 10.0, true));
        let ev = last_event(PALLETS, &core::pallet_id(&id, 2));
        assert!(["load_id", "number", "archived", "created_at", "updated_at"].iter().chain(SPOT_COLS.iter()).all(|k| ev.contains_key(*k)));
        // Refused spots (unknown building, removed building) write nothing: no pallet 3 appears.
        assert_eq!(start_load_pallet(id.clone(), Some(Place { floor_id: "flr-nope".into(), x: 1.0, y: 1.0, turned: false })).await.unwrap_err(), "No such building.");
        let gone = create_warehouse_floor("Old".into(), 50.0, 50.0, None).await.unwrap().floor;
        update_warehouse_floor(gone.id.clone(), None, None, None, None, Some(true)).await.unwrap();
        assert_eq!(start_load_pallet(id.clone(), Some(Place { floor_id: gone.id.clone(), x: 1.0, y: 1.0, turned: false })).await.unwrap_err(), "That building was removed.");
        assert_eq!(get_warehouse_load(id.clone()).await.unwrap().pallets.len(), 2);
        // Started anywhere else: no placement in the create event, and an answer that names the pallet.
        let d = start_load_pallet(id.clone(), None).await.unwrap();
        assert_eq!(d.started, Some(3));
        assert!(!SPOT_COLS.iter().any(|k| last_event(PALLETS, &core::pallet_id(&id, 3)).contains_key(*k)));
        assert_eq!(on_plan(&id, 3).await.floor_id, "");
        // Pallet 3 is placed and removed: its number comes back as a new pallet, standing nowhere.
        save_load_pallet(id.clone(), 3, None, None, None, None, None, Some(fl.id.clone()), Some(20.0), Some(20.0), None).await.unwrap();
        save_load_pallet(id.clone(), 3, None, None, None, None, Some(true), None, None, None, None).await.unwrap();
        let d = start_load_pallet(id.clone(), None).await.unwrap();
        assert_eq!(d.started, Some(3));
        let p = on_plan(&id, 3).await;
        assert_eq!((p.floor_id.as_str(), p.x, p.y), ("", 0.0, 0.0));
    }

    /// The list joins every pallet's position with the counts Deliveries shows, newest delivery
    /// first and then by number, leaves a removed delivery's pallets out, and still lists a pallet
    /// whose building was removed (the screen puts it in the tray).
    #[tokio::test]
    async fn the_floor_list_joins_positions_with_counts() {
        let _db = crate::db::init_test_store();
        let fl = create_warehouse_floor("Main".into(), 100.0, 60.0, None).await.unwrap().floor;
        let lines = || vec![line("a", "K1", &[("7", 4), ("8", 2)]), line("b", "K2", &[("S", 3)])];
        let older = create_warehouse_load("Older".into(), "o.xlsx".into(), lines(), None, None).await.unwrap().load.id;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let newer = create_warehouse_load("Newer".into(), "n.xlsx".into(), lines(), None, None).await.unwrap().load.id;
        let c = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }, CaseLine { line_id: "b".into(), size: "S".into(), pairs: 1 }];
        save_warehouse_case(older.clone(), None, 1, c.clone(), None, Some(2), None, None, None, None, None).await.unwrap();
        save_warehouse_case(older.clone(), None, 2, c.clone(), None, Some(1), Some("loose".into()), None, None, None, None).await.unwrap();
        // "Dock door", the location the R-535 test uses: the tests share one database, and a second
        // location here would show in that test's recent locations when the two run at once.
        save_load_pallet(older.clone(), 2, Some("Dock door".into()), None, Some(true), None, None, Some(fl.id.clone()), Some(12.0), Some(8.0), Some(true)).await.unwrap();
        start_load_pallet(newer.clone(), Some(Place { floor_id: fl.id.clone(), x: 40.0, y: 20.0, turned: false })).await.unwrap();

        let all = list_warehouse_floors().await.unwrap();
        let mine: Vec<&FloorPallet> = all.pallets.iter().filter(|p| p.load_id == older || p.load_id == newer).collect();
        // Newest delivery first, then pallet number.
        assert_eq!(mine.iter().map(|p| (p.load_name.as_str(), p.number)).collect::<Vec<_>>(), vec![("Newer", 1), ("Newer", 2), ("Older", 1), ("Older", 2)]);
        // The counts are exactly what the delivery's own screen shows.
        let d = get_warehouse_load(older.clone()).await.unwrap();
        for v in &d.pallets {
            let p = mine.iter().find(|p| p.load_id == older && p.number == v.pallet).unwrap();
            assert_eq!((p.boxes, p.loose, p.pairs, p.styles, p.closed, p.location.as_str()), (v.boxes, v.loose, v.pairs, v.styles, v.closed, v.location.as_str()));
            assert_eq!(p.id, core::pallet_id(&older, v.pallet));
        }
        let two = mine.iter().find(|p| p.load_id == older && p.number == 2).unwrap();
        assert_eq!((two.boxes, two.loose, two.pairs, two.closed, two.location.as_str()), (0, 3, 3, true, "Dock door"));
        assert_eq!((two.floor_id.as_str(), two.x, two.y, two.turned), (fl.id.as_str(), 12.0, 8.0, true));
        let one = mine.iter().find(|p| p.load_id == older && p.number == 1).unwrap();
        assert_eq!((one.boxes, one.pairs, one.floor_id.as_str()), (2, 6, ""));
        let n2 = mine.iter().find(|p| p.load_id == newer && p.number == 2).unwrap();
        assert_eq!((n2.floor_id.as_str(), n2.x, n2.y, n2.turned, n2.pairs), (fl.id.as_str(), 40.0, 20.0, false, 0));

        // A removed building keeps its pallets' floor_id in the list.
        update_warehouse_floor(fl.id.clone(), None, None, None, None, Some(true)).await.unwrap();
        let all = list_warehouse_floors().await.unwrap();
        assert!(all.floors.iter().any(|f| f.id == fl.id && f.archived));
        assert_eq!(on_plan(&older, 2).await.floor_id, fl.id);
        // A removed delivery's pallets are not listed.
        update_warehouse_load(newer.clone(), None, None, Some(true), None).await.unwrap();
        assert!(list_warehouse_floors().await.unwrap().pallets.iter().all(|p| p.load_id != newer));
    }

    /// R-554: a row of a delivery's pallets is drawn where it was measured (pallet 1, waiting for the
    /// truck, first), carries on, moves as one and is removed only when empty; a pallet's boxes are set
    /// up empty with their codes and filled one by one. The server's twins are its route tests.
    #[tokio::test]
    async fn rows_of_pallets_and_boxes_with_codes() {
        let _db = crate::db::init_test_store();
        let fl = create_warehouse_floor("Rows".into(), 100.0, 60.0, None).await.unwrap().floor;
        let load = create_warehouse_load("Row truck".into(), "r.xlsx".into(), vec![line("a", "K1", &[("7", 40), ("8", 40)])], None, None).await.unwrap().load.id;
        let mine = |l: &crate::warehouse_floors::FloorList| -> Vec<(i64, String, f64, f64)> {
            l.pallets.iter().filter(|p| p.load_id == load).map(|p| (p.number, p.location.clone(), p.x, p.y)).collect()
        };
        let l = draw_pallet_row(fl.id.clone(), load.clone(), None, 6.0, 10.0, true, 3, false, None).await.unwrap();
        assert_eq!(mine(&l), vec![(1, "A1".into(), 6.0, 10.0), (2, "A2".into(), 10.0, 10.0), (3, "A3".into(), 14.0, 10.0)]);
        let l = draw_pallet_row(fl.id.clone(), load.clone(), Some("a".into()), 18.0, 10.0, true, 1, false, None).await.unwrap();
        assert_eq!(mine(&l).last().cloned(), Some((4, "A4".into(), 18.0, 10.0)));
        let e = draw_pallet_row(fl.id.clone(), load.clone(), None, 90.0, 30.0, true, 4, false, None).await.unwrap_err();
        assert!(e.contains("2 would fit"), "{e}");
        let l = change_pallet_row(fl.id.clone(), "A".into(), Some(6.0), Some(20.0), Some(true), Some(false), Some(0.5), None).await.unwrap();
        assert_eq!(mine(&l).iter().map(|r| (r.2, r.3)).collect::<Vec<_>>(), vec![(6.0, 20.0), (10.5, 20.0), (15.0, 20.0), (19.5, 20.0)]);

        // Pallet A2: 2 rows of 3, six empty boxes coded A2-1 to A2-6.
        let d = set_pallet_boxes(load.clone(), 2, 2, 3, None).await.unwrap();
        let codes: Vec<String> = d.cases.iter().map(|c| c.code.clone()).collect();
        assert_eq!(codes, vec!["A2-1", "A2-2", "A2-3", "A2-4", "A2-5", "A2-6"]);
        let v = d.pallets.iter().find(|p| p.pallet == 2).unwrap();
        assert_eq!((v.boxes, v.filled, v.layers, v.per_layer), (6, 0, 2, 3));
        // Filled, then emptied again; a new box still needs a pair and takes the next code.
        let b2 = d.cases[1].id.clone();
        let d = save_warehouse_case(load.clone(), Some(b2.clone()), 2, vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 4 }], None, None, None, None, None, None, None).await.unwrap();
        assert_eq!((d.pallets.iter().find(|p| p.pallet == 2).unwrap().filled, d.stock.left), (1, 4));
        let d = save_warehouse_case(load.clone(), Some(b2.clone()), 2, vec![], None, None, None, Some(" x 9 ".into()), None, None, None).await.unwrap();
        assert_eq!((d.pallets.iter().find(|p| p.pallet == 2).unwrap().filled, d.cases[1].code.as_str()), (0, "x 9"));
        assert!(save_warehouse_case(load.clone(), None, 2, vec![], None, None, None, None, None, None, None).await.is_err());
        let d = save_warehouse_case(load.clone(), None, 2, vec![CaseLine { line_id: "a".into(), size: "8".into(), pairs: 2 }], None, None, None, None, None, None, None).await.unwrap();
        assert_eq!(d.cases.last().map(|c| c.code.as_str()), Some("A2-7"));
        assert!(set_pallet_boxes(load.clone(), 2, 2, 3, None).await.unwrap_err().contains("A2 already has 7 boxes"));
        let d = set_pallet_boxes(load.clone(), 2, 3, 3, None).await.unwrap();
        assert_eq!(d.cases.iter().filter(|c| c.pallet == 2).count(), 9);
        let fp = list_warehouse_floors().await.unwrap().pallets.into_iter().find(|p| p.load_id == load && p.number == 2).unwrap();
        assert_eq!((fp.boxes, fp.filled, fp.layers, fp.per_layer), (9, 1, 3, 3));

        // A row with boxes on it stays; an empty one goes.
        assert!(change_pallet_row(fl.id.clone(), "A".into(), None, None, None, None, None, Some(true)).await.unwrap_err().contains("A2 still has boxes"));
        draw_pallet_row(fl.id.clone(), load.clone(), Some("B".into()), 50.0, 0.0, false, 2, true, Some(0.5)).await.unwrap();
        let l = change_pallet_row(fl.id.clone(), "B".into(), None, None, None, None, None, Some(true)).await.unwrap();
        assert!(mine(&l).iter().all(|r| !r.1.starts_with('B')));
    }

    /// R-537 on the real sheet, read locally only: `R519_SHEET=path cargo test real_sheet_pictures
    /// -- --ignored`. A delivery saved from it takes every picture onto its own style, in the synced
    /// media folder and the upload queue; reading the file again changes nothing.
    #[tokio::test]
    #[ignore]
    async fn real_sheet_pictures() {
        let _db = crate::db::init_test_store();
        let path = std::env::var("R519_SHEET").expect("R519_SHEET");
        let read = read_load_manifest(path.clone()).await.unwrap();
        let lines: Vec<LoadLine> = serde_json::from_value(read["lines"].clone()).unwrap();
        let n = lines.len();
        let id = create_warehouse_load("Truck".into(), "shoes.xlsx".into(), lines, None, None).await.unwrap().load.id;
        let v = add_load_pictures(id.clone(), path.clone()).await.unwrap();
        assert_eq!(v["pictures"]["on_lines"], json!(n));
        assert_eq!(v["pictures"]["not_on_delivery"], json!(0));
        let saved = get_warehouse_load(id.clone()).await.unwrap().load.lines.unwrap();
        let base = crate::db::app_data_dir().join("sync");
        assert!(saved.iter().all(|l| l.image.starts_with(&format!("media/deliveries/{id}/")) && l.image.ends_with(".jpg") && base.join(&l.image).exists()));
        // One picture placed on several styles is one file.
        let files: std::collections::BTreeSet<&str> = saved.iter().map(|l| l.image.as_str()).collect();
        let queued: i64 = pool()
            .get()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM netsync_media_outbound WHERE kind = 'delivery' AND lot_id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(queued as usize, files.len());
        let v = add_load_pictures(id.clone(), path).await.unwrap();
        assert_eq!(v["pictures"]["on_lines"], json!(n));
        assert_eq!(get_warehouse_load(id).await.unwrap().load.lines.unwrap(), saved);
        println!("{n} lines, every one with its picture on disk; {} files queued", files.len());
    }
}
