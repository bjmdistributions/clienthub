//! Warehouse stock (R-326, R-327, R-328): products Jack physically holds.
//!
//! One `warehouse_items` row per product. `box_types_json` declares its box sizes once
//! ("Big Box" of 72); `sections_json` holds each section's (team's) whole boxes by size and
//! its loose units. Every change to a count is written to `log_json` (newest first, capped)
//! so "did we already pull the Dodgers for that order?" has an answer. The counting rules and
//! the spreadsheet reader are in `warehouse_core.rs`, byte-identical on the server — this
//! file is only storage, sync and the Tauri commands.
//!
//! Stock leaves through `warehouse_adjust`: an invoice made from the packer (the invoice
//! form calls it once the invoice exists), "Take out without an invoice", and a put-back.
//! A count typed on the product ("Update counts", the edit form, an import) is logged as a
//! `count` move by `save_warehouse_item`.
//!
//! Synced per column, last writer wins — see the vault's revisit/warehouse-counts-are-one-column.

use crate::db::pool;
use crate::warehouse_core::{self as core, BoxType, Change, ImportResult, Mapping, Move, Section, Short};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Serialize)]
pub struct WarehouseItem {
    pub id: String,
    pub name: String,
    pub section_label: String,
    pub box_types: Vec<BoxType>,
    pub sections: Vec<Section>,
    pub units_per_pallet: i64,
    pub unit_price: f64,
    pub notes: String,
    pub log: Vec<Move>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct WarehouseInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub section_label: String,
    #[serde(default)]
    pub box_types: Vec<BoxType>,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(default)]
    pub units_per_pallet: i64,
    #[serde(default)]
    pub unit_price: f64,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Serialize)]
pub struct AdjustResult {
    pub item: WarehouseItem,
    /// Sections that held less than was asked for, in units. Only what was there was taken.
    pub short: Vec<Short>,
}

#[derive(Debug, Serialize)]
pub struct SheetRead {
    pub rows: Vec<Vec<String>>,
    pub sheet_name: Option<String>,
    pub note: Option<String>,
    pub guess: Mapping,
}

const COLS: &str = "id, name, COALESCE(section_label,'Section'), COALESCE(sections_json,'[]'), \
    COALESCE(boxes_per_pallet,0), COALESCE(unit_price,0), COALESCE(notes,''), COALESCE(log_json,'[]'), \
    COALESCE(archived,0), created_at, updated_at, COALESCE(box_types_json,'[]'), COALESCE(units_per_pallet,0)";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<WarehouseItem> {
    let sections: String = r.get(3)?;
    let log: String = r.get(7)?;
    let types: String = r.get(11)?;
    let mut box_types: Vec<BoxType> = serde_json::from_str(&types).unwrap_or_default();
    let mut sections: Vec<Section> = serde_json::from_str(&sections).unwrap_or_default();
    core::upgrade(&mut box_types, &mut sections);
    let mut units_per_pallet: i64 = r.get(12)?;
    let boxes_per_pallet: i64 = r.get(4)?;
    // R-326 stored pallets as boxes; with one box size that is exactly units.
    if units_per_pallet == 0 && boxes_per_pallet > 0 && box_types.len() == 1 {
        units_per_pallet = boxes_per_pallet * box_types[0].per_box;
    }
    Ok(WarehouseItem {
        id: r.get(0)?,
        name: r.get(1)?,
        section_label: r.get(2)?,
        box_types,
        sections,
        units_per_pallet,
        unit_price: r.get(5)?,
        notes: r.get(6)?,
        log: serde_json::from_str(&log).unwrap_or_default(),
        archived: r.get::<_, i64>(8)? != 0,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn load(conn: &rusqlite::Connection, id: &str) -> Result<WarehouseItem, String> {
    conn.query_row(&format!("SELECT {COLS} FROM warehouse_items WHERE id = ?1"), [id], map_row)
        .map_err(|_| "That product is no longer in the warehouse.".to_string())
}

fn write(conn: &rusqlite::Connection, id: &str, cols: Map<String, Value>, create: bool) -> Result<(), String> {
    let keys: Vec<&String> = cols.keys().collect();
    let params: Vec<rusqlite::types::Value> = cols.values().map(to_sql).collect();
    if create {
        let sql = format!(
            "INSERT INTO warehouse_items (id, {}) VALUES (?1, {})",
            keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "),
            (2..=keys.len() + 1).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
        );
        let mut all = vec![rusqlite::types::Value::Text(id.to_string())];
        all.extend(params);
        conn.execute(&sql, rusqlite::params_from_iter(all.iter())).map_err(|e| e.to_string())?;
    } else {
        let sets: Vec<String> = keys.iter().enumerate().map(|(i, k)| format!("{k}=?{}", i + 1)).collect();
        let sql = format!("UPDATE warehouse_items SET {} WHERE id=?{}", sets.join(", "), keys.len() + 1);
        let mut all = params;
        all.push(rusqlite::types::Value::Text(id.to_string()));
        conn.execute(&sql, rusqlite::params_from_iter(all.iter())).map_err(|e| e.to_string())?;
    }
    crate::sync::record_upsert("warehouse_items", id, cols).map_err(|e| e.to_string())
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

fn json_str<T: Serialize>(v: &T) -> Value {
    Value::String(serde_json::to_string(v).unwrap_or_else(|_| "[]".into()))
}

/// Create or update a product from a whole picture of it. A changed count is logged.
fn save(conn: &rusqlite::Connection, input: WarehouseInput, note: &str) -> Result<WarehouseItem, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Give the product a name.".into());
    }
    let (box_types, sections) = core::clean(input.box_types, input.sections)?;
    let label = match input.section_label.trim() { "" => "Section".to_string(), l => l.to_string() };
    let now = chrono::Utc::now().to_rfc3339();
    let existing = match input.id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(load(conn, id)?),
        None => None,
    };
    let (id, mut log, old_types, old_sections) = match &existing {
        Some(e) => (e.id.clone(), e.log.clone(), e.box_types.clone(), e.sections.clone()),
        None => (uuid::Uuid::new_v4().to_string(), Vec::new(), Vec::new(), Vec::new()),
    };
    // A size that was just removed still has to price the boxes it held before.
    let mut all_types = box_types.clone();
    for t in old_types {
        if !all_types.iter().any(|x| x.id == t.id) {
            all_types.push(t);
        }
    }
    let lines = core::count_lines(&all_types, &old_sections, &sections);
    let log_changed = !lines.is_empty();
    if log_changed {
        let kind = if existing.is_none() { "in" } else { "count" };
        core::push_log(&mut log, Move { id: core::new_id(), at: now.clone(), kind: kind.into(), lines, reference: String::new(), note: note.into(), undone: false });
    }
    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("section_label".into(), json!(label));
    cols.insert("box_types_json".into(), json_str(&box_types));
    cols.insert("sections_json".into(), json_str(&sections));
    cols.insert("units_per_pallet".into(), json!(input.units_per_pallet.max(0)));
    cols.insert("unit_price".into(), json!(input.unit_price.max(0.0)));
    cols.insert("notes".into(), json!(input.notes.trim()));
    cols.insert("updated_at".into(), json!(now));
    if existing.is_none() || log_changed {
        cols.insert("log_json".into(), json_str(&log));
    }
    if existing.is_none() {
        // A create event carries every NOT NULL column, or another device's INSERT OR
        // IGNORE writes nothing and says nothing (decisions/a-create-event-carries-every-not-null-column).
        cols.insert("archived".into(), json!(0));
        cols.insert("created_at".into(), json!(now));
    }
    write(conn, &id, cols, existing.is_none())?;
    load(conn, &id)
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

#[tauri::command]
pub async fn list_warehouse_items() -> Result<Vec<WarehouseItem>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM warehouse_items ORDER BY LOWER(name)"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn save_warehouse_item(input: WarehouseInput) -> Result<WarehouseItem, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    save(&conn, input, "")
}

/// Archive (or bring back) a product. Nothing is deleted.
#[tauri::command]
pub async fn archive_warehouse_item(id: String, archived: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    load(&conn, &id)?;
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(archived as i64));
    cols.insert("updated_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    write(&conn, &id, cols, false)
}

/// Move stock in or out and log it. With `undo_of`, the changes are worked out from the
/// logged move itself (boxes back, opened boxes closed), and that move is marked undone so
/// it cannot be put back twice.
#[tauri::command]
pub async fn warehouse_adjust(
    id: String,
    changes: Vec<Change>,
    reference: Option<String>,
    note: Option<String>,
    undo_of: Option<String>,
) -> Result<AdjustResult, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut item = load(&conn, &id)?;
    let changes = match undo_of.as_deref() {
        Some(u) => match item.log.iter().find(|m| m.id == u) {
            Some(m) if m.undone => return Err("That move was already put back.".into()),
            Some(m) => core::undo_changes(m),
            None => return Err("That move is no longer in the history.".into()),
        },
        None => changes,
    };
    let (lines, short) = core::apply_changes(&item.box_types, &mut item.sections, &changes)?;
    if lines.is_empty() {
        return Err("Nothing to move — those sections have nothing left.".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(u) = undo_of.as_deref() {
        if let Some(m) = item.log.iter_mut().find(|m| m.id == u) { m.undone = true; }
    }
    let kind = core::kind_of(&lines).to_string();
    core::push_log(&mut item.log, Move {
        id: core::new_id(),
        at: now.clone(),
        kind,
        lines,
        reference: reference.unwrap_or_default().trim().to_string(),
        note: note.unwrap_or_default().trim().to_string(),
        undone: false,
    });
    let mut cols = Map::new();
    cols.insert("sections_json".into(), json_str(&item.sections));
    cols.insert("log_json".into(), json_str(&item.log));
    cols.insert("updated_at".into(), json!(now));
    write(&conn, &id, cols, false)?;
    Ok(AdjustResult { item: load(&conn, &id)?, short })
}

/// Read a dropped or picked spreadsheet (CSV, TSV, Excel) into rows, with a first guess at
/// what each column is. Uses the lot engine's reader, which takes the sheet with the most rows.
#[tauri::command]
pub async fn warehouse_read_sheet(path: String) -> Result<SheetRead, String> {
    let sheet = tokio::task::spawn_blocking(move || crate::lot_engine::read::read_sheet(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Couldn't read that sheet: {e}"))?;
    let guess = core::guess_mapping(&sheet.rows);
    Ok(SheetRead { rows: sheet.rows, sheet_name: sheet.sheet_name, note: sheet.note, guess })
}

/// A first guess at the columns of rows that did not come from a file (a paste).
#[tauri::command]
pub async fn warehouse_guess(rows: Vec<Vec<String>>) -> Result<Mapping, String> {
    Ok(core::guess_mapping(&rows))
}

#[tauri::command]
pub async fn warehouse_import_preview(rows: Vec<Vec<String>>, mapping: Mapping) -> Result<ImportResult, String> {
    Ok(core::apply_mapping(&rows, &mapping))
}

/// Save an import: as a new product (`target_id` empty, `name` given), or into a product,
/// replacing the counts of the sections the sheet names or (`add`) adding to them.
#[tauri::command]
pub async fn warehouse_import(
    rows: Vec<Vec<String>>,
    mapping: Mapping,
    target_id: Option<String>,
    name: Option<String>,
    section_label: Option<String>,
    add: bool,
) -> Result<WarehouseItem, String> {
    let imp = core::apply_mapping(&rows, &mapping);
    if imp.sections.is_empty() {
        return Err("Nothing in that sheet could be read with these columns.".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let input = match target_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => {
            let cur = load(&conn, id)?;
            let (mut types, mut sections) = (cur.box_types, cur.sections);
            core::merge_import(&mut types, &mut sections, &imp, add);
            WarehouseInput {
                id: Some(cur.id), name: cur.name, section_label: cur.section_label, box_types: types, sections,
                units_per_pallet: cur.units_per_pallet, unit_price: cur.unit_price, notes: cur.notes,
            }
        }
        None => WarehouseInput {
            id: None,
            name: name.unwrap_or_default(),
            section_label: section_label.unwrap_or_default(),
            box_types: imp.box_types,
            sections: imp.sections,
            units_per_pallet: 0,
            unit_price: 0.0,
            notes: String::new(),
        },
    };
    save(&conn, input, "Imported from a sheet")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn input(id: Option<String>, sections: Vec<Section>, types: Vec<BoxType>) -> WarehouseInput {
        WarehouseInput { id, name: "New Era 59FIFTY".into(), section_label: "Team".into(), box_types: types, sections, units_per_pallet: 1440, unit_price: 9.0, notes: String::new() }
    }

    /// End to end on the real schema: create, pick, put back, recount, import.
    #[tokio::test]
    async fn save_pick_put_back_recount_import() {
        crate::db::init_test_store();
        let types = vec![
            BoxType { id: String::new(), name: "Big Box".into(), per_box: 72 },
            BoxType { id: String::new(), name: "Small Box".into(), per_box: 12 },
        ];
        // Types need ids before sections can point at them, as the form does.
        let first = save_warehouse_item(input(None, vec![], types)).await.unwrap();
        let big = first.box_types[0].id.clone();
        let small = first.box_types[1].id.clone();
        let sections = vec![
            Section { name: "Yankees".into(), counts: BTreeMap::from([(big.clone(), 10), (small.clone(), 5)]), ..Default::default() },
            Section { name: "Dodgers".into(), counts: BTreeMap::from([(small.clone(), 4)]), ..Default::default() },
        ];
        let item = save_warehouse_item(input(Some(first.id.clone()), sections, first.box_types.clone())).await.unwrap();
        assert_eq!(item.log[0].kind, "count");
        assert_eq!(item.units_per_pallet, 1440);
        let nyy = item.sections[0].id.clone();

        // 500 units by the rule: 6 Big (432), all 5 Small (60), then 8 loose out of an opened Big.
        let r = warehouse_adjust(item.id.clone(), vec![Change { section_id: nyy.clone(), units: -500, ..Default::default() }],
            Some("INV-1001".into()), None, None).await.unwrap();
        assert!(r.short.is_empty());
        let y = &r.item.sections[0];
        assert_eq!(core::units_of(&r.item.box_types, y), 720 + 60 - 500);
        assert_eq!(r.item.log[0].reference, "INV-1001");
        assert_eq!(r.item.log[0].kind, "out");

        let pick = r.item.log[0].id.clone();
        let back = warehouse_adjust(item.id.clone(), vec![], None, Some("Put back".into()), Some(pick.clone())).await.unwrap();
        assert_eq!(back.item.sections[0].counts, BTreeMap::from([(big.clone(), 10), (small.clone(), 5)]));
        assert_eq!(back.item.sections[0].loose, 0);
        assert!(warehouse_adjust(item.id.clone(), vec![], None, None, Some(pick)).await.is_err());

        // An import into the product replaces the named team's counts and adds a new one.
        let rows: Vec<Vec<String>> = "Team,Pack size,Total units\nDodgers,12,30\nMets,12,24"
            .lines().map(|l| l.split(',').map(String::from).collect()).collect();
        let m = core::guess_mapping(&rows);
        let imported = warehouse_import(rows, m, Some(item.id.clone()), None, None, false).await.unwrap();
        let dodgers = imported.sections.iter().find(|s| s.name == "Dodgers").unwrap();
        assert_eq!((dodgers.counts.get(&small).copied(), dodgers.loose), (Some(2), 6));
        assert!(imported.sections.iter().any(|s| s.name == "Mets"));
        assert_eq!(imported.log[0].note, "Imported from a sheet");
    }
}
