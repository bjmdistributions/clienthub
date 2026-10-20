//! The floor plan's buildings (R-550): the warehouse drawn to scale in feet, one `warehouse_floors`
//! row per building with its doors and rooms in `shape_json`.
//!
//! Where each delivery pallet stands is on the pallet's own row (`warehouse_load_pallets.floor_id,
//! x, y, turned`) and is written by `warehouse_loads.rs`. Cleaning a building and keeping a pallet
//! inside its walls are `floor_core.rs`, byte-identical on the server (clienthub-api
//! `routes/floor_core.rs`, behind `routes/warehouse_floors.rs`): this file is only storage, sync and
//! the Tauri commands. A removed building is archived, never deleted.

use crate::db::pool;
use crate::floor_core::{self as core, FloorPallet, FloorShape};
use crate::warehouse_loads::{floor_pallets, now, write};
use serde::Serialize;
use serde_json::{json, Map, Value};

const FLOORS: &str = "warehouse_floors";

/// A building as the screens see it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Floor {
    pub id: String,
    pub name: String,
    pub width: f64,
    pub depth: f64,
    pub shape: FloorShape,
    pub archived: bool,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct FloorList {
    /// Every building, removed ones too (they carry `archived`).
    pub floors: Vec<Floor>,
    /// Every pallet of every delivery that is not removed, placed or not.
    pub pallets: Vec<FloorPallet>,
}

#[derive(Debug, Serialize)]
pub struct FloorOne {
    pub floor: Floor,
}

const FLOOR_COLS: &str = "id, COALESCE(name,''), COALESCE(width,0), COALESCE(depth,0), COALESCE(shape_json,'{}'), COALESCE(archived,0), updated_at";

fn map_floor(r: &rusqlite::Row) -> rusqlite::Result<Floor> {
    let shape: String = r.get(4)?;
    Ok(Floor {
        id: r.get(0)?,
        name: r.get(1)?,
        width: r.get(2)?,
        depth: r.get(3)?,
        shape: serde_json::from_str(&shape).unwrap_or_default(),
        archived: r.get::<_, i64>(5)? != 0,
        updated_at: r.get(6)?,
    })
}

/// One building by id, removed or not.
pub(crate) fn floor(conn: &rusqlite::Connection, id: &str) -> Result<Floor, String> {
    conn.query_row(&format!("SELECT {FLOOR_COLS} FROM warehouse_floors WHERE id = ?1"), [id], map_floor)
        .map_err(|_| "No such building.".to_string())
}

fn shape_str(shape: &FloorShape) -> String {
    serde_json::to_string(shape).unwrap_or_else(|_| "{}".into())
}

/// Every building (removed ones too) and every pallet of every delivery, placed or not.
#[tauri::command]
pub async fn list_warehouse_floors() -> Result<FloorList, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {FLOOR_COLS} FROM warehouse_floors ORDER BY created_at, id"))
        .map_err(|e| e.to_string())?;
    let floors: Vec<Floor> = stmt.query_map([], map_floor).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(FloorList { floors, pallets: floor_pallets(&conn)? })
}

/// Draw a new building. Its size, doors and rooms go through `clean_floor` first.
#[tauri::command]
pub async fn create_warehouse_floor(name: String, width: f64, depth: f64, shape: Option<FloorShape>) -> Result<FloorOne, String> {
    let clean = core::clean_floor(&name, width, depth, shape.unwrap_or_default())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let id = format!("flr-{}", uuid::Uuid::new_v4().simple());
    let t = now();
    // A create event carries every column: a device that sees the building first sees all of it.
    let mut cols = Map::new();
    cols.insert("name".into(), json!(clean.name));
    cols.insert("width".into(), json!(clean.width));
    cols.insert("depth".into(), json!(clean.depth));
    cols.insert("shape_json".into(), Value::String(shape_str(&clean.shape)));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    write(&conn, FLOORS, &id, cols, true)?;
    Ok(FloorOne { floor: floor(&conn, &id)? })
}

/// Rename, resize, change the doors and rooms, remove (archived, never deleted) or bring back. A
/// change to the name, size or shape is cleaned as a whole (shrinking pulls rooms and doors inside
/// the new walls) and only the columns that changed are written, so two devices changing different
/// things do not overwrite each other.
#[tauri::command]
pub async fn update_warehouse_floor(id: String, name: Option<String>, width: Option<f64>, depth: Option<f64>, shape: Option<FloorShape>, archived: Option<bool>) -> Result<FloorOne, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let was = floor(&conn, &id)?;
    let mut cols = Map::new();
    if name.is_some() || width.is_some() || depth.is_some() || shape.is_some() {
        let clean = core::clean_floor(
            name.as_deref().unwrap_or(&was.name),
            width.unwrap_or(was.width),
            depth.unwrap_or(was.depth),
            shape.unwrap_or_else(|| was.shape.clone()),
        )?;
        if clean.name != was.name {
            cols.insert("name".into(), json!(clean.name));
        }
        if clean.width != was.width {
            cols.insert("width".into(), json!(clean.width));
        }
        if clean.depth != was.depth {
            cols.insert("depth".into(), json!(clean.depth));
        }
        if clean.shape != was.shape {
            cols.insert("shape_json".into(), Value::String(shape_str(&clean.shape)));
        }
    }
    if let Some(a) = archived {
        if a != was.archived {
            cols.insert("archived".into(), json!(a as i64));
        }
    }
    if !cols.is_empty() {
        cols.insert("updated_at".into(), json!(now()));
        write(&conn, FLOORS, &id, cols, false)?;
    }
    Ok(FloorOne { floor: floor(&conn, &id)? })
}
