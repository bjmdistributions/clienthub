//! The floor plan's buildings (R-550): the warehouse drawn to scale in feet, one `warehouse_floors`
//! row per building with its doors and rooms in `shape_json`.
//!
//! Where each delivery pallet stands is on the pallet's own row (`warehouse_load_pallets.floor_id,
//! x, y, turned`) and is written by `warehouse_loads.rs`. Cleaning a building and keeping a pallet
//! inside its walls are `floor_core.rs`, byte-identical on the server (clienthub-api
//! `routes/floor_core.rs`, behind `routes/warehouse_floors.rs`): this file is only storage, sync and
//! the Tauri commands. A removed building is archived, never deleted.

use crate::case_core;
use crate::db::pool;
use crate::floor_core::{self as core, FloorPallet, FloorShape};
use crate::warehouse_loads::{cases, floor_pallets, load, now, pallet_cols, pallet_records, pallet_row_exists, put_spot, write, Spot};
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

// ---------------------------------------------------------------------------------------
// R-554: rows of pallets, measured. A row belongs to a building: its pallets are named by their
// location, the row's letters and their place in it (A1, A2...). The server's twins are
// `POST /api/warehouse/floors/:id/rows` and `.../rows/:name`; the shape of a row is
// `floor_core::row_spots`.

const PALLETS: &str = "warehouse_load_pallets";

/// A live building, or why not.
fn live_floor(conn: &rusqlite::Connection, id: &str) -> Result<Floor, String> {
    let f = floor(conn, id)?;
    if f.archived {
        return Err("That building was removed.".into());
    }
    Ok(f)
}

/// One pallet standing on a building, as a row sees it: (id, delivery, number, location).
fn stood_on(conn: &rusqlite::Connection, floor_id: &str) -> Result<Vec<(String, String, i64, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.load_id, COALESCE(p.number,0), COALESCE(p.location,'') FROM warehouse_load_pallets p \
             JOIN warehouse_loads l ON l.id = p.load_id \
             WHERE p.floor_id = ?1 AND COALESCE(p.archived,0) = 0 AND COALESCE(l.archived,0) = 0",
        )
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([floor_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(out)
}

/// A row's pallets on this building, first to last, as (place in the row, index into `stood`).
fn row_members(stood: &[(String, String, i64, String)], name: &str) -> Vec<(i64, usize)> {
    let mut m: Vec<(i64, usize)> = stood
        .iter()
        .enumerate()
        .filter_map(|(k, p)| core::row_of(&p.3).filter(|(n, _)| n == name).map(|(_, i)| (i, k)))
        .collect();
    m.sort();
    m
}

/// Draw a row of a delivery's pallets, empty, exactly where it was measured: `count` pallets from the
/// first one's corner (`x`, `y` feet from the left and top walls), along the top wall (`across`) or
/// down the side, `gap` feet apart. The delivery's open, empty pallets that stand on no floor plan go
/// first (pallet 1 waiting for the truck), then new ones are started. Each is named by its place in
/// the row, after the last already in it on this building. A row past a wall is refused, saying why.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn draw_pallet_row(floor_id: String, load_id: String, name: Option<String>, x: f64, y: f64, across: bool, count: i64, turned: bool, gap: Option<f64>) -> Result<FloorList, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let f = live_floor(&conn, &floor_id)?;
    let l = load(&conn, load_id.trim()).map_err(|_| "Choose the delivery the pallets are from.".to_string())?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let load_id = load_id.trim().to_string();
    let stood = stood_on(&conn, &f.id)?;
    let name = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => core::clean_row_name(n)?,
        None => {
            let used: Vec<String> = stood.iter().filter_map(|p| core::row_of(&p.3).map(|(n, _)| n)).collect();
            core::next_row_name(&used)
        }
    };
    let spots = core::row_spots(f.width, f.depth, x, y, across, count, turned, gap.unwrap_or(0.0))?;
    let after = row_members(&stood, &name).last().map(|m| m.0).unwrap_or(0);
    // The delivery's open, empty pallets on no live building, lowest number first.
    let live: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM warehouse_floors WHERE COALESCE(archived,0) = 0").map_err(|e| e.to_string())?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        ids
    };
    let have = cases(&conn, &load_id)?;
    let mut records = pallet_records(&conn, &load_id)?;
    let waiting: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT COALESCE(number,0), COALESCE(floor_id,'') FROM warehouse_load_pallets WHERE load_id = ?1 AND COALESCE(archived,0) = 0 AND COALESCE(closed,0) = 0 ORDER BY number")
            .map_err(|e| e.to_string())?;
        let all: Vec<(i64, String)> = stmt.query_map([&load_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        all.into_iter().filter(|(n, fl)| !live.contains(fl) && !have.iter().any(|c| c.pallet == *n)).map(|(n, _)| n).collect()
    };
    let mut waiting = waiting.into_iter();
    let t = now();
    for (k, (x, y)) in spots.into_iter().enumerate() {
        let number = match waiting.next() {
            Some(n) => n,
            None => case_core::next_pallet(&records, &have),
        };
        if number > 999 {
            return Err("Pallet numbers run from 1 to 999.".into());
        }
        let (x, y) = core::clean_spot(f.width, f.depth, x, y, turned)?;
        let pid = case_core::pallet_id(&load_id, number);
        let exists = pallet_row_exists(&conn, &pid);
        let recorded = records.iter().any(|r| r.number == number);
        let mut cols = if exists { Map::new() } else { pallet_cols(&load_id, number, &t) };
        if exists && !recorded {
            // A removed pallet's number started again is a new, open pallet.
            cols.insert("archived".into(), json!(0));
            cols.insert("closed".into(), json!(0));
        }
        cols.insert("location".into(), json!(format!("{name}{}", after + 1 + k as i64)));
        put_spot(&mut cols, &Spot { floor_id: f.id.clone(), x, y, turned });
        cols.insert("updated_at".into(), json!(t));
        write(&conn, PALLETS, &pid, cols, !exists)?;
        if !recorded {
            records.push(case_core::PalletRecord { id: pid, number, ..Default::default() });
        }
    }
    Ok(FloorList { floors: all_floors(&conn)?, pallets: floor_pallets(&conn)? })
}

/// Lay a row out again from a new corner (every pallet in it, in order), or remove it: every pallet of
/// it archived, refused while any has boxes or loose items on it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn change_pallet_row(floor_id: String, name: String, x: Option<f64>, y: Option<f64>, across: Option<bool>, turned: Option<bool>, gap: Option<f64>, remove: Option<bool>) -> Result<FloorList, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let f = live_floor(&conn, &floor_id)?;
    let name = core::clean_row_name(&name)?;
    let stood = stood_on(&conn, &f.id)?;
    let members = row_members(&stood, &name);
    if members.is_empty() {
        return Err(format!("There is no row {name} on {}.", f.name));
    }
    let t = now();
    if remove.unwrap_or(false) {
        let mut full: Vec<String> = Vec::new();
        for (_, k) in &members {
            let p = &stood[*k];
            if cases(&conn, &p.1)?.iter().any(|c| c.pallet == p.2) {
                full.push(p.3.clone());
            }
        }
        if !full.is_empty() {
            return Err(format!(
                "{} still {} boxes or loose items on {}. Move or remove them first.",
                full.join(", "),
                if full.len() == 1 { "has" } else { "have" },
                if full.len() == 1 { "it" } else { "them" }
            ));
        }
        for (_, k) in &members {
            let mut cols = Map::new();
            cols.insert("archived".into(), json!(1));
            cols.insert("updated_at".into(), json!(t));
            write(&conn, PALLETS, &stood[*k].0, cols, false)?;
        }
    } else {
        let (x, y) = match (x, y) {
            (Some(x), Some(y)) => (x, y),
            _ => return Err("Say where the row's first pallet stands.".into()),
        };
        let turned = turned.unwrap_or(false);
        let spots = core::row_spots(f.width, f.depth, x, y, across.unwrap_or(true), members.len() as i64, turned, gap.unwrap_or(0.0))?;
        for ((_, k), (x, y)) in members.iter().zip(spots) {
            let (x, y) = core::clean_spot(f.width, f.depth, x, y, turned)?;
            let mut cols = Map::new();
            put_spot(&mut cols, &Spot { floor_id: f.id.clone(), x, y, turned });
            cols.insert("updated_at".into(), json!(t));
            write(&conn, PALLETS, &stood[*k].0, cols, false)?;
        }
    }
    Ok(FloorList { floors: all_floors(&conn)?, pallets: floor_pallets(&conn)? })
}

/// Every building, removed ones too.
fn all_floors(conn: &rusqlite::Connection) -> Result<Vec<Floor>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {FLOOR_COLS} FROM warehouse_floors ORDER BY created_at, id"))
        .map_err(|e| e.to_string())?;
    let floors: Vec<Floor> = stmt.query_map([], map_floor).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(floors)
}
