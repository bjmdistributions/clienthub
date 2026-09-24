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
use crate::pallet_fit::{self, Capacity, FitRequest, FitResult, FitType, PalletLine, PalletPlan, PalletSetup, PalletSpec};
use crate::warehouse_core::{self as core, BoxType, Change, ImportResult, LayoutCell, LayoutShape, MapStock, Mapping, Move, PlaceMove, Section, Short};
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
    /// The pallet and each box size's measurements (R-346).
    pub pallet: PalletSetup,
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
    /// Sent only by the Pallets screen; absent, the stored setup stays as it is (R-346).
    #[serde(default)]
    pub pallet: Option<PalletSetup>,
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

const ITEMS: &str = "warehouse_items";
const LAYOUTS: &str = "warehouse_layouts";

const COLS: &str = "id, name, COALESCE(section_label,'Section'), COALESCE(sections_json,'[]'), \
    COALESCE(boxes_per_pallet,0), COALESCE(unit_price,0), COALESCE(notes,''), COALESCE(log_json,'[]'), \
    COALESCE(archived,0), created_at, updated_at, COALESCE(box_types_json,'[]'), COALESCE(units_per_pallet,0), COALESCE(pallet_json,'{}')";

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
    // R-345: no pallet size set reads as 21 of the biggest box, on every screen.
    let units_per_pallet = core::pallet_units(units_per_pallet, &box_types);
    let pallet: String = r.get(13)?;
    Ok(WarehouseItem {
        id: r.get(0)?,
        name: r.get(1)?,
        section_label: r.get(2)?,
        box_types,
        sections,
        units_per_pallet,
        unit_price: r.get(5)?,
        notes: r.get(6)?,
        pallet: serde_json::from_str(&pallet).unwrap_or_default(),
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

fn write(conn: &rusqlite::Connection, table: &str, id: &str, cols: Map<String, Value>, create: bool) -> Result<(), String> {
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
        core::push_log(&mut log, Move { id: core::new_id(), at: now.clone(), kind: kind.into(), lines, reference: String::new(), note: note.into(), undone: false, places: Vec::new() });
    }
    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("section_label".into(), json!(label));
    cols.insert("box_types_json".into(), json_str(&box_types));
    cols.insert("sections_json".into(), json_str(&sections));
    // R-346: measurements, when this save carries them; and once the pallet and the biggest box are
    // measured, the pallet size is what the fitter says a pallet of them holds, not a typed number.
    let ids: Vec<&str> = box_types.iter().map(|t| t.id.as_str()).collect();
    let setup = input.pallet.map(|p| pallet_fit::clean_setup(p, &ids));
    if let Some(s) = &setup {
        cols.insert("pallet_json".into(), json_str(s));
    }
    let mut units_per_pallet = input.units_per_pallet.max(0);
    let stored = existing.as_ref().map(|e| e.pallet.clone()).unwrap_or_default();
    if let Some(big) = box_types.iter().filter(|t| t.per_box > 0).max_by_key(|t| t.per_box) {
        if let Some(u) = pallet_fit::pallet_units_from(setup.as_ref().unwrap_or(&stored), &big.id, &big.name, big.per_box) {
            units_per_pallet = u;
        }
    }
    cols.insert("units_per_pallet".into(), json!(units_per_pallet));
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
    write(conn, ITEMS, &id, cols, existing.is_none())?;
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
    write(&conn, ITEMS, &id, cols, false)
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
    places: Option<Vec<PlaceMove>>,
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
        return Err("Nothing to move. Those sections have nothing left.".into());
    }
    // R-340: the same boxes come off (or go back on) the map's pallets and shelf levels.
    let places = move_places(&conn, &item, undo_of.as_deref(), places.unwrap_or_default(), &lines)?;
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
        places,
    });
    let mut cols = Map::new();
    cols.insert("sections_json".into(), json_str(&item.sections));
    cols.insert("log_json".into(), json_str(&item.log));
    cols.insert("updated_at".into(), json!(now));
    write(&conn, ITEMS, &id, cols, false)?;
    Ok(AdjustResult { item: load(&conn, &id)?, short })
}

/// Take a move's boxes off the map's places (or, for a put-back, return them where they came
/// from), write every map that changed, and say what moved — recorded on the move.
fn move_places(conn: &rusqlite::Connection, item: &WarehouseItem, undo_of: Option<&str>, named: Vec<PlaceMove>, lines: &[core::MoveLine]) -> Result<Vec<PlaceMove>, String> {
    let maps = all_maps(conn)?;
    // A grab names its pallet (R-342); otherwise the boxes come off by the rule.
    let named = core::taking(named);
    let moves: Vec<PlaceMove> = if undo_of.is_none() && !named.is_empty() { named } else { match undo_of {
        Some(u) => item.log.iter().find(|m| m.id == u).map(|m| m.places.iter().map(|p| PlaceMove {
            boxes: p.boxes.iter().map(|(t, n)| (t.clone(), -n)).collect(), ..p.clone()
        }).collect()).unwrap_or_default(),
        None => {
            // Boxes come off live maps only; a put-back returns them even to a removed one.
            let view: Vec<(String, MapStock, Vec<(String, String, String)>)> = maps.iter().filter(|m| !m.archived).map(|m| (m.id.clone(), m.stock.clone(), core::map_places(&m.cells, &m.shape))).collect();
            core::boxes_out(lines).iter().flat_map(|(sid, take)| core::take_from_places(&view, &item.id, sid, take)).collect()
        }
    } };
    let now = chrono::Utc::now().to_rfc3339();
    let mut applied: Vec<PlaceMove> = Vec::new();
    for m in &maps {
        if !moves.iter().any(|p| p.layout_id == m.id) {
            continue;
        }
        let mut stock = m.stock.clone();
        applied.extend(core::apply_place_moves(&mut stock, &m.cells, &m.shape, &m.id, &moves));
        if stock != m.stock {
            let mut cols = Map::new();
            cols.insert("stock_json".into(), json_str(&stock));
            cols.insert("updated_at".into(), json!(now));
            write(conn, LAYOUTS, &m.id, cols, false)?;
        }
    }
    Ok(applied)
}

/// Every map, oldest first — the order places are taken in (removed ones only get boxes back).
fn all_maps(conn: &rusqlite::Connection) -> Result<Vec<WarehouseLayout>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {LAYOUT_COLS} FROM warehouse_layouts ORDER BY created_at"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_layout).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
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
                units_per_pallet: cur.units_per_pallet, unit_price: cur.unit_price, notes: cur.notes, pallet: None,
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
            pallet: None,
        },
    };
    save(&conn, input, "Imported from a sheet")
}

// ---------------------------------------------------------------------------------------
// Fitting boxes onto pallets (R-346): pure work on what it is sent — pallet_fit.rs, the same
// file the server runs, so the desktop and the phone always show the same pallets.
// ---------------------------------------------------------------------------------------

/// The most of each measured box size one pallet holds, with the full pallet placed box by box.
#[tauri::command]
pub async fn warehouse_pallet_capacity(pallet: PalletSpec, types: Vec<FitType>) -> Result<Vec<Capacity>, String> {
    pallet_fit::capacities(&pallet, &types)
}

/// A load, fitted onto pallets box by box. Every pallet passes pallet_fit::check first.
#[tauri::command]
pub async fn warehouse_fit_pallets(request: FitRequest) -> Result<FitResult, String> {
    pallet_fit::fit(&request)
}

// ---------------------------------------------------------------------------------------
// The pallets of an order (R-347, R-348): what is on each, its picture, the link its QR code
// opens, and the order's passcode. Jack types them ("12 pallets like this") or they come from
// Build this lot; combining two is the same fitter proving they go on one.
// ---------------------------------------------------------------------------------------

const PALLETS: &str = "warehouse_pallets";
/// Where a pallet's QR code points: the server's public manifest page.
pub const MANIFEST_BASE: &str = "https://ecliptr.app/p/";
const MAX_NEW_PALLETS: i64 = 200;

#[derive(Debug, Serialize, Clone)]
pub struct WarehousePallet {
    pub id: String,
    pub invoice_id: String,
    pub invoice_number: String,
    pub client_name: String,
    pub item_id: String,
    pub number: i64,
    pub lines: Vec<PalletLine>,
    pub plan: Option<PalletPlan>,
    pub token: String,
    pub passcode: String,
    pub notes: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewPallet {
    #[serde(default)]
    pub lines: Vec<PalletLine>,
    /// "12 pallets like this".
    #[serde(default)]
    pub copies: Option<i64>,
    /// The fitted pallet from Build this lot; kept only if it holds exactly these lines and checks.
    #[serde(default)]
    pub plan: Option<PalletPlan>,
    #[serde(default)]
    pub notes: Option<String>,
}

const PALLET_SELECT: &str = "SELECT p.id, COALESCE(p.invoice_id,''), COALESCE(i.number,''), COALESCE(c.name,''), COALESCE(p.item_id,''), \
    COALESCE(p.number,0), COALESCE(p.lines_json,'[]'), COALESCE(p.plan_json,''), COALESCE(p.token,''), COALESCE(p.passcode,''), \
    COALESCE(p.notes,''), COALESCE(p.archived,0), p.created_at, p.updated_at \
    FROM warehouse_pallets p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN clients c ON c.id = i.client_id";

fn map_pallet(r: &rusqlite::Row) -> rusqlite::Result<WarehousePallet> {
    let lines: String = r.get(6)?;
    let plan: String = r.get(7)?;
    Ok(WarehousePallet {
        id: r.get(0)?,
        invoice_id: r.get(1)?,
        invoice_number: r.get(2)?,
        client_name: r.get(3)?,
        item_id: r.get(4)?,
        number: r.get(5)?,
        lines: serde_json::from_str(&lines).unwrap_or_default(),
        plan: if plan.trim().is_empty() { None } else { serde_json::from_str(&plan).ok() },
        token: r.get(8)?,
        passcode: r.get(9)?,
        notes: r.get(10)?,
        archived: r.get::<_, i64>(11)? != 0,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
    })
}

fn pallets_where(conn: &rusqlite::Connection, clause: &str, param: &str) -> Result<Vec<WarehousePallet>, String> {
    let sql = format!("{PALLET_SELECT} WHERE {clause} ORDER BY p.number, p.created_at");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([param], map_pallet).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn order_pallets(conn: &rusqlite::Connection, invoice_id: &str) -> Result<Vec<WarehousePallet>, String> {
    pallets_where(conn, "p.invoice_id = ?1 AND COALESCE(p.archived,0) = 0", invoice_id)
}

/// The order's passcode: kept on every pallet of the order, removed ones included, so an order
/// whose pallets were all removed and built again keeps the code its customer was sent.
fn order_code(conn: &rusqlite::Connection, invoice_id: &str) -> String {
    conn.query_row(
        "SELECT COALESCE(passcode,'') FROM warehouse_pallets WHERE invoice_id = ?1 ORDER BY updated_at DESC LIMIT 1",
        [invoice_id],
        |r| r.get(0),
    )
    .unwrap_or_default()
}

fn load_pallet(conn: &rusqlite::Connection, id: &str) -> Result<WarehousePallet, String> {
    pallets_where(conn, "p.id = ?1", id)?.into_iter().next().filter(|p| !p.archived).ok_or_else(|| "That pallet is no longer there.".to_string())
}

/// An unguessable link code: 20 hex characters.
fn pallet_token() -> String {
    uuid::Uuid::new_v4().simple().to_string().chars().take(20).collect()
}

/// An order's pallets numbered 1, 2, 3… in the order they stand, after one is removed or combined.
fn renumber(conn: &rusqlite::Connection, invoice_id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    for (k, p) in order_pallets(conn, invoice_id)?.into_iter().enumerate() {
        let want = k as i64 + 1;
        if p.number != want {
            let mut cols = Map::new();
            cols.insert("number".into(), json!(want));
            cols.insert("updated_at".into(), json!(now));
            write(conn, PALLETS, &p.id, cols, false)?;
        }
    }
    Ok(())
}

fn plan_value(plan: &Option<PalletPlan>) -> Value {
    match plan {
        Some(p) => json_str(p),
        None => json!(""),
    }
}

/// Every pallet not removed, newest orders first (the screen groups them by order).
#[tauri::command]
pub async fn list_warehouse_pallets() -> Result<Vec<WarehousePallet>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    // (The archived flag is a number: compared with a number, never a bound '0' text.)
    let mut v = pallets_where(&conn, "COALESCE(p.archived,0) = 0 AND p.id <> ?1", "")?;
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.number.cmp(&b.number)));
    Ok(v)
}

/// Pallets onto an order: each worked out (and pictured when measured) before any is written, so a
/// pallet that does not fit stops the whole lot with the reason.
#[tauri::command]
pub async fn add_warehouse_pallets(invoice_id: String, item_id: String, pallets: Vec<NewPallet>) -> Result<Vec<WarehousePallet>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if invoice_id.trim().is_empty() {
        return Err("Choose the order these pallets belong to.".into());
    }
    let found: i64 = conn.query_row("SELECT COUNT(*) FROM invoices WHERE id = ?1", [&invoice_id], |r| r.get(0)).unwrap_or(0);
    if found == 0 {
        return Err("That order is no longer there.".into());
    }
    let item = load(&conn, &item_id)?;
    let mut ready: Vec<(Vec<PalletLine>, Option<PalletPlan>, String, i64)> = Vec::new();
    let mut total = 0;
    for (k, np) in pallets.into_iter().enumerate() {
        // A kind set to 0 pallets is left out, never made into one.
        let copies = np.copies.unwrap_or(1).min(MAX_NEW_PALLETS);
        if copies <= 0 {
            continue;
        }
        let lines = pallet_fit::clean_lines(&np.lines).map_err(|e| format!("Pallet {}: {e}", k + 1))?;
        let plan = pallet_fit::keep_or_plan(&item.pallet, &lines, np.plan).map_err(|e| format!("Pallet {}: {e}", k + 1))?;
        total += copies;
        ready.push((lines, plan, np.notes.unwrap_or_default().trim().to_string(), copies));
    }
    if ready.is_empty() {
        return Err("Add at least one pallet.".into());
    }
    if total > MAX_NEW_PALLETS {
        return Err(format!("More than {MAX_NEW_PALLETS} pallets at once."));
    }
    // The order numbered 1, 2, 3… first: two devices adding at once can leave two pallets with one
    // number, and this heals it before the new ones follow on.
    renumber(&conn, &invoice_id)?;
    let passcode = order_code(&conn, &invoice_id);
    let mut next = order_pallets(&conn, &invoice_id)?.len() as i64 + 1;
    let now = chrono::Utc::now().to_rfc3339();
    for (lines, plan, notes, copies) in ready {
        for _ in 0..copies {
            let mut cols = Map::new();
            cols.insert("invoice_id".into(), json!(invoice_id));
            cols.insert("item_id".into(), json!(item_id));
            cols.insert("number".into(), json!(next));
            cols.insert("lines_json".into(), json_str(&lines));
            cols.insert("plan_json".into(), plan_value(&plan));
            cols.insert("token".into(), json!(pallet_token()));
            cols.insert("passcode".into(), json!(passcode));
            cols.insert("notes".into(), json!(notes));
            cols.insert("archived".into(), json!(0));
            cols.insert("created_at".into(), json!(now));
            cols.insert("updated_at".into(), json!(now));
            write(&conn, PALLETS, &uuid::Uuid::new_v4().to_string(), cols, true)?;
            next += 1;
        }
    }
    order_pallets(&conn, &invoice_id)
}

/// A pallet's contents changed: pictured again (or refused when they no longer go on one).
#[tauri::command]
pub async fn update_warehouse_pallet(id: String, lines: Vec<PalletLine>, notes: Option<String>) -> Result<WarehousePallet, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let p = load_pallet(&conn, &id)?;
    let setup = load(&conn, &p.item_id).map(|i| i.pallet).unwrap_or_default();
    let lines = pallet_fit::clean_lines(&lines)?;
    let plan = pallet_fit::plan_lines(&setup, &lines)?;
    let mut cols = Map::new();
    cols.insert("lines_json".into(), json_str(&lines));
    cols.insert("plan_json".into(), plan_value(&plan));
    if let Some(n) = notes {
        cols.insert("notes".into(), json!(n.trim()));
    }
    cols.insert("updated_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    write(&conn, PALLETS, &id, cols, false)?;
    load_pallet(&conn, &id)
}

/// Two or more pallets of one order as one: the fitter must get them all on one pallet (when
/// measured), the lowest-numbered keeps everything, the rest are removed and the order renumbered.
#[tauri::command]
pub async fn combine_warehouse_pallets(ids: Vec<String>) -> Result<Vec<WarehousePallet>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if ids.len() < 2 {
        return Err("Choose at least two pallets to combine.".into());
    }
    let mut ps: Vec<WarehousePallet> = ids.iter().map(|id| load_pallet(&conn, id)).collect::<Result<_, _>>()?;
    ps.sort_by_key(|p| p.number);
    ps.dedup_by(|a, b| a.id == b.id);
    if ps.len() < 2 {
        return Err("Choose at least two pallets to combine.".into());
    }
    if ps.iter().any(|p| p.invoice_id != ps[0].invoice_id) {
        return Err("Only pallets of the same order combine.".into());
    }
    if ps.iter().any(|p| p.item_id != ps[0].item_id) {
        return Err("Only pallets of the same product combine.".into());
    }
    let setup = load(&conn, &ps[0].item_id).map(|i| i.pallet).unwrap_or_default();
    let merged = pallet_fit::merge_lines(&ps.iter().map(|p| p.lines.clone()).collect::<Vec<_>>())?;
    let plan = pallet_fit::plan_lines(&setup, &merged)?;
    let now = chrono::Utc::now().to_rfc3339();
    let keep = &ps[0];
    let mut cols = Map::new();
    cols.insert("lines_json".into(), json_str(&merged));
    cols.insert("plan_json".into(), plan_value(&plan));
    let notes: Vec<&str> = ps.iter().map(|p| p.notes.as_str()).filter(|n| !n.is_empty()).collect();
    cols.insert("notes".into(), json!(notes.join(" · ")));
    cols.insert("updated_at".into(), json!(now));
    write(&conn, PALLETS, &keep.id, cols, false)?;
    for p in &ps[1..] {
        let mut cols = Map::new();
        cols.insert("archived".into(), json!(1));
        cols.insert("updated_at".into(), json!(now));
        write(&conn, PALLETS, &p.id, cols, false)?;
    }
    renumber(&conn, &keep.invoice_id)?;
    order_pallets(&conn, &keep.invoice_id)
}

/// A pallet taken off its order (archived, never deleted); the rest renumbered.
#[tauri::command]
pub async fn remove_warehouse_pallet(id: String) -> Result<Vec<WarehousePallet>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let p = load_pallet(&conn, &id)?;
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(1));
    cols.insert("updated_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    write(&conn, PALLETS, &id, cols, false)?;
    renumber(&conn, &p.invoice_id)?;
    order_pallets(&conn, &p.invoice_id)
}

/// The passcode someone must type to open this order's manifests ('' for none), on every pallet.
#[tauri::command]
pub async fn set_order_passcode(invoice_id: String, passcode: String) -> Result<Vec<WarehousePallet>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let code = passcode.trim().to_string();
    if code.chars().count() > 40 {
        return Err("Keep the passcode to 40 characters or fewer.".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    // Every pallet of the order, removed ones too (see order_code).
    for p in pallets_where(&conn, "p.invoice_id = ?1", &invoice_id)? {
        if p.passcode != code {
            let mut cols = Map::new();
            cols.insert("passcode".into(), json!(code));
            cols.insert("updated_at".into(), json!(now));
            write(&conn, PALLETS, &p.id, cols, false)?;
        }
    }
    order_pallets(&conn, &invoice_id)
}

/// 4 × 6 in labels, one a pallet: the pallet's number of the order, the order, the product, a QR
/// code to its manifest, and what is on it. Opened as a PDF for the label printer.
#[tauri::command]
pub async fn warehouse_pallet_labels(app: tauri::AppHandle, ids: Vec<String>) -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut labels = Vec::new();
    for id in &ids {
        let p = load_pallet(&conn, id)?;
        let of = order_pallets(&conn, &p.invoice_id)?.len();
        let product = load(&conn, &p.item_id).map(|i| i.name).unwrap_or_default();
        labels.push((p, of, product));
    }
    if labels.is_empty() {
        return Err("Choose the pallets to print.".into());
    }
    let bytes = pallet_labels_pdf(&labels)?;
    let dir = crate::db::app_data_dir().join("labels");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("pallet-labels-{}.pdf", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().to_string();
    use tauri_plugin_shell::ShellExt;
    app.shell().open(path.clone(), None).map_err(|e| e.to_string())?;
    Ok(path)
}

/// The QR code of a link, as its dark modules: (width, [row-major dark?]).
pub fn qr_modules(text: &str) -> Result<(usize, Vec<bool>), String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).map_err(|e| e.to_string())?;
    Ok((code.width(), code.to_colors().into_iter().map(|c| c == qrcode::Color::Dark).collect()))
}

fn pallet_labels_pdf(labels: &[(WarehousePallet, usize, String)]) -> Result<Vec<u8>, String> {
    use printpdf::*;
    const W: f32 = 101.6; // 4 in
    const H: f32 = 152.4; // 6 in
    const M: f32 = 6.0;
    let (doc, p1, l1) = PdfDocument::new("Pallet labels", Mm(W), Mm(H), "Label");
    let bold = doc.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    let regular = doc.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let n0 = |n: i64| {
        let s = n.abs().to_string();
        let mut out = String::new();
        for (i, ch) in s.chars().enumerate() {
            if i > 0 && (s.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(ch);
        }
        if n < 0 { format!("-{out}") } else { out }
    };
    let cut = |s: &str, n: usize| if s.chars().count() > n { format!("{}…", s.chars().take(n - 1).collect::<String>()) } else { s.to_string() };
    for (k, (p, of, product)) in labels.iter().enumerate() {
        let layer = if k == 0 { doc.get_page(p1).get_layer(l1) } else { let (pi, li) = doc.add_page(Mm(W), Mm(H), "Label"); doc.get_page(pi).get_layer(li) };
        layer.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));
        let mut y = H - M - 12.0;
        layer.use_text(format!("Pallet {}", p.number), 34.0, Mm(M), Mm(y), &bold);
        layer.use_text(format!("of {of}"), 14.0, Mm(M + 1.0), Mm(y - 8.0), &regular);
        y -= 16.0;
        let order = [if p.invoice_number.is_empty() { String::new() } else { format!("Order {}", p.invoice_number) }, p.client_name.clone()]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
        if !order.is_empty() {
            layer.use_text(cut(&order, 42), 11.0, Mm(M), Mm(y), &bold);
            y -= 5.5;
        }
        if !product.is_empty() {
            layer.use_text(cut(product, 48), 9.5, Mm(M), Mm(y), &regular);
            y -= 4.0;
        }
        // The QR code, centred: its link opens this pallet's manifest.
        let (n, dark) = qr_modules(&format!("{MANIFEST_BASE}{}", p.token))?;
        let side = 58.0_f32;
        let quiet = 4.0; // modules of white around it
        let cell = side / (n as f32 + 2.0 * quiet);
        let x0 = (W - side) / 2.0 + quiet * cell;
        let top = y - 2.0 - quiet * cell;
        for r in 0..n {
            for c in 0..n {
                if dark[r * n + c] {
                    let (lx, ty) = (x0 + c as f32 * cell, top - r as f32 * cell);
                    // A hair over a cell so neighbouring modules print as one block.
                    layer.add_rect(Rect::new(Mm(lx), Mm(ty - cell - 0.02), Mm(lx + cell + 0.02), Mm(ty)));
                }
            }
        }
        y = top - n as f32 * cell - quiet * cell - 4.0;
        let scan = if p.passcode.is_empty() { "Scan for the full manifest".to_string() } else { "Scan for the full manifest (passcode needed)".to_string() };
        layer.use_text(scan, 8.5, Mm(M), Mm(y), &regular);
        y -= 7.0;
        let (boxes, units): (i64, i64) = p.lines.iter().fold((0, 0), |a, l| (a.0 + l.boxes, a.1 + l.boxes * l.per_box));
        layer.use_text(format!("{} boxes · {} units", n0(boxes), n0(units)), 12.0, Mm(M), Mm(y), &bold);
        y -= 6.0;
        let room = ((y - M) / 4.6).floor().max(0.0) as usize;
        let shown = if p.lines.len() > room { room.saturating_sub(1) } else { p.lines.len() };
        for l in p.lines.iter().take(shown) {
            layer.use_text(cut(&format!("{} · {} of {} · {}", l.name, l.type_name, l.per_box, n0(l.boxes)), 50), 9.0, Mm(M), Mm(y), &regular);
            y -= 4.6;
        }
        if shown < p.lines.len() {
            layer.use_text(format!("and {} more: scan for all", p.lines.len() - shown), 9.0, Mm(M), Mm(y), &regular);
        }
    }
    let mut writer = std::io::BufWriter::new(Vec::new());
    doc.save(&mut writer).map_err(|e| e.to_string())?;
    writer.into_inner().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// The warehouse map (R-330): a floor of pallet spots or a run of shelving, each spot saying
// what sits there and how full it is; R-332/R-333 add its shape (rows of their own lengths,
// row titles, doors, short names, shelves on the floor). Cleaned by warehouse_core::clean_layout.
// ---------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct WarehouseLayout {
    pub id: String,
    pub name: String,
    /// "pallets" | "shelving"
    pub kind: String,
    pub rows: i64,
    pub cols: i64,
    pub cells: Vec<LayoutCell>,
    pub shape: LayoutShape,
    /// Boxes recorded on each place (R-340); set place by place, never with the map.
    pub stock: MapStock,
    pub notes: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct LayoutInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    pub rows: i64,
    pub cols: i64,
    #[serde(default)]
    pub cells: Vec<LayoutCell>,
    /// None from a caller that predates R-332: the stored shape is kept as it is.
    #[serde(default)]
    pub shape: Option<LayoutShape>,
    #[serde(default)]
    pub notes: String,
}

const LAYOUT_COLS: &str = "id, name, COALESCE(kind,'pallets'), COALESCE(rows,1), COALESCE(cols,1), COALESCE(cells_json,'[]'),     COALESCE(notes,''), COALESCE(archived,0), created_at, updated_at, COALESCE(shape_json,'{}'), COALESCE(stock_json,'{}')";

fn map_layout(r: &rusqlite::Row) -> rusqlite::Result<WarehouseLayout> {
    let cells: String = r.get(5)?;
    Ok(WarehouseLayout {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        rows: r.get(3)?,
        cols: r.get(4)?,
        cells: serde_json::from_str(&cells).unwrap_or_default(),
        shape: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        stock: serde_json::from_str(&r.get::<_, String>(11)?).unwrap_or_default(),
        notes: r.get(6)?,
        archived: r.get::<_, i64>(7)? != 0,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

fn load_layout(conn: &rusqlite::Connection, id: &str) -> Result<WarehouseLayout, String> {
    conn.query_row(&format!("SELECT {LAYOUT_COLS} FROM warehouse_layouts WHERE id = ?1"), [id], map_layout)
        .map_err(|_| "That map is no longer there.".to_string())
}

#[tauri::command]
pub async fn list_warehouse_layouts() -> Result<Vec<WarehouseLayout>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {LAYOUT_COLS} FROM warehouse_layouts ORDER BY created_at"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_layout).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Create or update a map from the whole picture of it.
#[tauri::command]
pub async fn save_warehouse_layout(input: LayoutInput) -> Result<WarehouseLayout, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Give the map a name, like \"Floor\" or \"Rack A\".".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let existing = match input.id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(load_layout(&conn, id)?),
        None => None,
    };
    // A caller that sends no shape keeps the stored one (and the spots are cleaned against it).
    let send_shape = input.shape.is_some();
    let shape = input.shape.unwrap_or_else(|| existing.as_ref().map(|e| e.shape.clone()).unwrap_or_default());
    let m = core::clean_layout(&input.kind, input.rows, input.cols, input.cells, shape)?;
    let id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let mut cols_map = Map::new();
    cols_map.insert("name".into(), json!(name));
    cols_map.insert("kind".into(), json!(m.kind));
    cols_map.insert("rows".into(), json!(m.rows));
    cols_map.insert("cols".into(), json!(m.cols));
    cols_map.insert("cells_json".into(), json_str(&m.cells));
    if send_shape || existing.is_none() {
        cols_map.insert("shape_json".into(), json_str(&m.shape));
    }
    // The boxes on each place are never sent with the map; they are only cleaned against it,
    // so a spot re-marked with another team, or taken out, drops what was recorded on it.
    let stored = existing.as_ref().map(|e| e.stock.clone()).unwrap_or_default();
    let stock = core::clean_stock(stored.clone(), &m.cells, &m.shape);
    if stock != stored || existing.is_none() {
        cols_map.insert("stock_json".into(), json_str(&stock));
    }
    cols_map.insert("notes".into(), json!(input.notes.trim()));
    cols_map.insert("updated_at".into(), json!(now));
    if existing.is_none() {
        cols_map.insert("archived".into(), json!(0));
        cols_map.insert("created_at".into(), json!(now));
    }
    write(&conn, LAYOUTS, &id, cols_map, existing.is_none())?;
    load_layout(&conn, &id)
}

/// Change the boxes recorded on one place of a map (R-340): a pallet spot "r:c" or a shelf
/// level "r:c:L", for the team marked there. `boxes` puts sizes at numbers, `add` moves sizes by
/// some — against what is stored now. Only that place changes.
#[tauri::command]
pub async fn set_warehouse_place_stock(layout_id: String, place: String, item_id: String, section_id: String, boxes: Option<std::collections::BTreeMap<String, i64>>, add: Option<std::collections::BTreeMap<String, i64>>) -> Result<WarehouseLayout, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let l = load_layout(&conn, &layout_id)?;
    let mut stock = l.stock.clone();
    core::change_place_stock(&mut stock, &l.cells, &l.shape, &place, &item_id, &section_id, &boxes.unwrap_or_default(), &add.unwrap_or_default())?;
    if stock != l.stock {
        let mut cols = Map::new();
        cols.insert("stock_json".into(), json_str(&stock));
        cols.insert("updated_at".into(), json!(chrono::Utc::now().to_rfc3339()));
        write(&conn, LAYOUTS, &layout_id, cols, false)?;
    }
    load_layout(&conn, &layout_id)
}

/// Archive (or bring back) a map. Nothing is deleted.
#[tauri::command]
pub async fn archive_warehouse_layout(id: String, archived: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    load_layout(&conn, &id)?;
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(archived as i64));
    cols.insert("updated_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    write(&conn, LAYOUTS, &id, cols, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn input(id: Option<String>, sections: Vec<Section>, types: Vec<BoxType>) -> WarehouseInput {
        WarehouseInput { id, name: "New Era 59FIFTY".into(), section_label: "Team".into(), box_types: types, sections, units_per_pallet: 1440, unit_price: 9.0, notes: String::new(), pallet: None }
    }

    /// End to end on the real schema: create, pick, put back, recount, import.
    #[tokio::test]
    async fn save_pick_put_back_recount_import() {
        let _db = crate::db::init_test_store();
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
            Some("INV-1001".into()), None, None, None).await.unwrap();
        assert!(r.short.is_empty());
        let y = &r.item.sections[0];
        assert_eq!(core::units_of(&r.item.box_types, y), 720 + 60 - 500);
        assert_eq!(r.item.log[0].reference, "INV-1001");
        assert_eq!(r.item.log[0].kind, "out");

        let pick = r.item.log[0].id.clone();
        let back = warehouse_adjust(item.id.clone(), vec![], None, Some("Put back".into()), Some(pick.clone()), None).await.unwrap();
        assert_eq!(back.item.sections[0].counts, BTreeMap::from([(big.clone(), 10), (small.clone(), 5)]));
        assert_eq!(back.item.sections[0].loose, 0);
        assert!(warehouse_adjust(item.id.clone(), vec![], None, None, Some(pick), None).await.is_err());

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

    #[tokio::test]
    async fn a_map_saves_and_shrinks() {
        let _db = crate::db::init_test_store();
        let cell = |r, c, fill| LayoutCell { r, c, fill, label: "Owls".into(), ..Default::default() };
        let m = save_warehouse_layout(LayoutInput {
            id: None, name: "Floor".into(), kind: "pallets".into(), rows: 4, cols: 6,
            cells: vec![cell(0, 0, 4), cell(3, 5, 2)], shape: None, notes: String::new(),
        }).await.unwrap();
        assert_eq!((m.kind.as_str(), m.cells.len()), ("pallets", 2));
        let smaller = save_warehouse_layout(LayoutInput {
            id: Some(m.id.clone()), name: "Floor".into(), kind: "pallets".into(), rows: 2, cols: 6, cells: m.cells, shape: None, notes: String::new(),
        }).await.unwrap();
        assert_eq!(smaller.cells.len(), 1);
        // R-332: rows of their own lengths and a door; a save that sends no shape keeps them.
        let door = core::Door { side: "bottom".into(), at: 1, width: 2, kind: "garage".into(), label: "Dock 1".into(), ..Default::default() };
        let shaped = save_warehouse_layout(LayoutInput {
            id: Some(m.id.clone()), name: "Floor".into(), kind: "pallets".into(), rows: 2, cols: 6, cells: smaller.cells.clone(),
            shape: Some(LayoutShape { row_lengths: vec![6, 3], doors: vec![door], ..Default::default() }), notes: String::new(),
        }).await.unwrap();
        assert_eq!((shaped.shape.row_lengths.clone(), shaped.shape.doors.len()), (vec![6, 3], 1));
        let kept = save_warehouse_layout(LayoutInput {
            id: Some(m.id.clone()), name: "Floor".into(), kind: "pallets".into(), rows: 2, cols: 6, cells: vec![cell(1, 5, 4)], shape: None, notes: String::new(),
        }).await.unwrap();
        assert_eq!((kept.shape.row_lengths.clone(), kept.shape.doors.len(), kept.cells.len()), (vec![6, 3], 1, 0));
        archive_warehouse_layout(m.id.clone(), true).await.unwrap();
        assert!(list_warehouse_layouts().await.unwrap().iter().any(|l| l.id == m.id && l.archived));
    }

    /// R-340: boxes recorded on a pallet come off it when stock leaves, part pallets first,
    /// and a put-back returns them.
    /// R-347/R-348: an order's pallets — twelve like this, combined, removed, a passcode, labels.
    #[tokio::test]
    async fn an_orders_pallets_add_combine_renumber_and_print() {
        let _db = crate::db::init_test_store();
        let types = vec![BoxType { id: String::new(), name: "Big Box".into(), per_box: 72 }];
        let it = save_warehouse_item(input(None, vec![], types)).await.unwrap();
        let big = it.box_types[0].id.clone();
        let mut setup = PalletSetup::default();
        setup.pallet = PalletSpec { length: 48.0, width: 40.0, deck: 6.0, max_height: 72.0 };
        setup.boxes.insert(big.clone(), pallet_fit::BoxSize { length: 24.0, width: 20.0, height: 12.0, side_ok: false });
        let it = save_warehouse_item(WarehouseInput { pallet: Some(setup), ..input(Some(it.id.clone()), vec![], it.box_types.clone()) }).await.unwrap();
        {
            let conn = pool().get().unwrap();
            conn.execute("INSERT INTO clients (id, name, created_at, updated_at) VALUES ('c-pal', 'Harbour Goods', 'now', 'now')", []).unwrap();
            conn.execute("INSERT INTO invoices (id, client_id, number, issue_date, due_date, line_items_json, subtotal, total, created_at) VALUES ('inv-pal', 'c-pal', 'INV-PAL-1', 'd', 'd', '[]', 0, 0, 'now')", []).unwrap();
        }
        let line = |n: i64| PalletLine { section_id: "owls".into(), name: "OWLS".into(), type_id: big.clone(), type_name: "Big Box".into(), per_box: 72, boxes: n };
        // 288 boxes on 12 pallets: 24 does not go on one (20 a pallet here) — refused, nothing written.
        let e = add_warehouse_pallets("inv-pal".into(), it.id.clone(), vec![NewPallet { lines: vec![line(24)], copies: Some(12), plan: None, notes: None }]).await.unwrap_err();
        assert!(e.contains("do not go on one pallet"), "{e}");
        assert!(list_warehouse_pallets().await.unwrap().is_empty());
        // 12 of 8 each: numbered 1..12, each pictured, each with its own link code.
        let ps = add_warehouse_pallets("inv-pal".into(), it.id.clone(), vec![NewPallet { lines: vec![line(8)], copies: Some(12), plan: None, notes: None }]).await.unwrap();
        assert_eq!(ps.len(), 12);
        assert_eq!(ps.iter().map(|p| p.number).collect::<Vec<_>>(), (1..=12).collect::<Vec<i64>>());
        assert!(ps.iter().all(|p| p.plan.as_ref().map_or(false, |x| x.pallet.boxes.len() == 8)));
        assert_eq!(ps.iter().map(|p| p.token.clone()).collect::<std::collections::BTreeSet<_>>().len(), 12);
        assert_eq!(ps[0].invoice_number, "INV-PAL-1");
        assert_eq!(ps[0].client_name, "Harbour Goods");
        // Combine 2 and 3: 16 on one, the order is 11 pallets numbered 1..11.
        let after = combine_warehouse_pallets(vec![ps[2].id.clone(), ps[1].id.clone()]).await.unwrap();
        assert_eq!(after.len(), 11);
        assert_eq!(after[1].lines[0].boxes, 16);
        assert_eq!(after.iter().map(|p| p.number).collect::<Vec<_>>(), (1..=11).collect::<Vec<i64>>());
        // Three together (24) do not go on one pallet: refused, nothing changed.
        assert!(combine_warehouse_pallets(vec![after[1].id.clone(), after[2].id.clone()]).await.is_err());
        assert_eq!(list_warehouse_pallets().await.unwrap().len(), 11);
        // A passcode on the order, carried by a pallet added later.
        set_order_passcode("inv-pal".into(), " harbour7 ".into()).await.unwrap();
        let more = add_warehouse_pallets("inv-pal".into(), it.id.clone(), vec![NewPallet { lines: vec![line(4)], copies: None, plan: None, notes: None }]).await.unwrap();
        assert!(more.iter().all(|p| p.passcode == "harbour7"));
        assert_eq!(more.last().unwrap().number, 12);
        // Removed: archived, the rest renumbered.
        let left = remove_warehouse_pallet(more[0].id.clone()).await.unwrap();
        assert_eq!(left.len(), 11);
        assert_eq!(left[0].number, 1);
        // A label: a PDF, and a QR that decodes to the manifest link.
        let label = pallet_labels_pdf(&[(left[0].clone(), left.len(), "New Era 59FIFTY".into())]).unwrap();
        assert!(label.starts_with(b"%PDF"));
        let (n, dark) = qr_modules(&format!("{MANIFEST_BASE}{}", left[0].token)).unwrap();
        assert_eq!(dark.len(), n * n);
        // To look at a label: PALLET_LABEL_OUT=<path> cargo test … writes the PDF there.
        if let Ok(out) = std::env::var("PALLET_LABEL_OUT") {
            std::fs::write(out, &label).unwrap();
        }
        // Every pallet removed and built again: the order keeps its passcode; a kind set to 0 makes none.
        for p in &left {
            remove_warehouse_pallet(p.id.clone()).await.unwrap();
        }
        let again = add_warehouse_pallets("inv-pal".into(), it.id.clone(), vec![
            NewPallet { lines: vec![line(4)], copies: Some(2), plan: None, notes: None },
            NewPallet { lines: vec![line(4)], copies: Some(0), plan: None, notes: None },
        ]).await.unwrap();
        assert_eq!(again.len(), 2);
        assert!(again.iter().all(|p| p.passcode == "harbour7"));
        // Two pallets with one number (two devices adding at once) are numbered again by the next add.
        pool().get().unwrap().execute("UPDATE warehouse_pallets SET number = 1 WHERE invoice_id = 'inv-pal'", []).unwrap();
        let healed = add_warehouse_pallets("inv-pal".into(), it.id.clone(), vec![NewPallet { lines: vec![line(4)], copies: None, plan: None, notes: None }]).await.unwrap();
        assert_eq!(healed.iter().map(|p| p.number).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    /// R-346: measurements save in their own column and set the pallet size; a save without them keeps them.
    #[tokio::test]
    async fn measured_boxes_set_the_pallet_size_and_a_save_without_them_keeps_them() {
        let _db = crate::db::init_test_store();
        let types = vec![BoxType { id: String::new(), name: "Big Box".into(), per_box: 72 }];
        let it = save_warehouse_item(input(None, vec![], types)).await.unwrap();
        let big = it.box_types[0].id.clone();
        let mut setup = PalletSetup::default();
        setup.pallet = PalletSpec { length: 48.0, width: 40.0, deck: 6.0, max_height: 60.0 };
        setup.boxes.insert(big.clone(), pallet_fit::BoxSize { length: 24.0, width: 20.0, height: 12.0, side_ok: false });
        setup.boxes.insert("gone".into(), pallet_fit::BoxSize { length: 1.0, width: 1.0, height: 1.0, side_ok: false });
        let measured = save_warehouse_item(WarehouseInput { pallet: Some(setup), ..input(Some(it.id.clone()), vec![], it.box_types.clone()) }).await.unwrap();
        // 4 a layer, 4 layers under 54 in: 16 Big Box, whatever was typed.
        assert_eq!(measured.units_per_pallet, 16 * 72);
        assert!(!measured.pallet.boxes.contains_key("gone"), "only the product's own sizes are kept");
        // An older screen saving the product without measurements keeps them, and the size they give.
        let again = save_warehouse_item(input(Some(it.id.clone()), vec![], it.box_types.clone())).await.unwrap();
        assert_eq!(again.pallet.boxes.get(&big).map(|b| b.height), Some(12.0));
        assert_eq!(again.units_per_pallet, 16 * 72);
        let r = warehouse_fit_pallets(FitRequest {
            pallet: again.pallet.pallet.clone(),
            types: vec![FitType { type_id: big.clone(), name: "Big Box".into(), per_box: 72, size: again.pallet.boxes[&big].clone() }],
            groups: vec![pallet_fit::FitGroup { section_id: "owls".into(), name: "Owls".into(), type_id: big.clone(), boxes: 20 }],
            big_alone: true,
        }).await.unwrap();
        assert_eq!(r.pallets.len(), 2);
        assert_eq!(r.pallets.iter().map(|p| p.boxes.len()).sum::<usize>(), 20);
    }

    /// R-345: a product saved with no pallet size reads as 21 of its biggest box; one he set is kept.
    #[tokio::test]
    async fn no_pallet_size_reads_as_21_of_the_biggest_box() {
        let _db = crate::db::init_test_store();
        let types = vec![
            BoxType { id: String::new(), name: "Big Box".into(), per_box: 72 },
            BoxType { id: String::new(), name: "Small Box".into(), per_box: 12 },
        ];
        let blank = WarehouseInput { units_per_pallet: 0, ..input(None, vec![], types.clone()) };
        let it = save_warehouse_item(blank).await.unwrap();
        assert_eq!(it.units_per_pallet, 21 * 72);
        let listed = list_warehouse_items().await.unwrap().into_iter().find(|x| x.id == it.id).unwrap();
        assert_eq!(listed.units_per_pallet, 21 * 72);
        let set = save_warehouse_item(input(Some(it.id.clone()), vec![], it.box_types.clone())).await.unwrap();
        assert_eq!(set.units_per_pallet, 1440, "a pallet size he set is kept");
    }

    #[tokio::test]
    async fn a_pick_takes_boxes_off_the_pallets_and_a_put_back_returns_them() {
        let _db = crate::db::init_test_store();
        let types = vec![BoxType { id: String::new(), name: "Big Box".into(), per_box: 72 }];
        let first = save_warehouse_item(input(None, vec![], types)).await.unwrap();
        let big = first.box_types[0].id.clone();
        let sections = vec![Section { name: "Owls".into(), counts: BTreeMap::from([(big.clone(), 30)]), ..Default::default() }];
        let item = save_warehouse_item(input(Some(first.id.clone()), sections, first.box_types.clone())).await.unwrap();
        let owls = item.sections[0].id.clone();
        let spot = |c| LayoutCell { r: 0, c, item_id: item.id.clone(), section_id: owls.clone(), fill: 4, ..Default::default() };
        let map = save_warehouse_layout(LayoutInput {
            id: None, name: "Floor".into(), kind: "pallets".into(), rows: 1, cols: 3, cells: vec![spot(0), spot(1)], shape: None, notes: String::new(),
        }).await.unwrap();
        set_warehouse_place_stock(map.id.clone(), "0:0".into(), item.id.clone(), owls.clone(), Some(BTreeMap::from([(big.clone(), 20)])), None).await.unwrap();
        let l = set_warehouse_place_stock(map.id.clone(), "0:1".into(), item.id.clone(), owls.clone(), Some(BTreeMap::from([(big.clone(), 6)])), None).await.unwrap();
        assert_eq!(l.stock.len(), 2);
        // A spot not marked with the team is refused.
        assert!(set_warehouse_place_stock(map.id.clone(), "0:2".into(), item.id.clone(), owls.clone(), Some(BTreeMap::from([(big.clone(), 1)])), None).await.is_err());

        // 10 boxes: the part pallet's 6 first, then 4 off the full one.
        let r = warehouse_adjust(item.id.clone(), vec![Change { section_id: owls.clone(), boxes: BTreeMap::from([(big.clone(), -10)]), ..Default::default() }],
            Some("INV-7".into()), None, None, None).await.unwrap();
        assert_eq!(r.item.log[0].places.len(), 2);
        let after = list_warehouse_layouts().await.unwrap().into_iter().find(|x| x.id == map.id).unwrap();
        assert_eq!(after.stock.get("0:0").map(|p| p.boxes[&big]), Some(16));
        assert!(after.stock["0:1"].boxes.is_empty()); // emptied, and known to be empty

        // Put back: the same pallets get them again.
        warehouse_adjust(item.id.clone(), vec![], None, None, Some(r.item.log[0].id.clone()), None).await.unwrap();
        let back = list_warehouse_layouts().await.unwrap().into_iter().find(|x| x.id == map.id).unwrap();
        assert_eq!(back.stock.get("0:0").map(|p| p.boxes[&big]), Some(20));
        assert_eq!(back.stock.get("0:1").map(|p| p.boxes[&big]), Some(6));

        // A map save never carries the boxes, but re-marking a spot drops what was on it.
        let mut cells = back.cells.clone();
        cells[1].label = "Returns".into();
        cells[1].section_id.clear();
        let saved = save_warehouse_layout(LayoutInput {
            id: Some(map.id.clone()), name: "Floor".into(), kind: "pallets".into(), rows: 1, cols: 3, cells, shape: None, notes: String::new(),
        }).await.unwrap();
        assert!(saved.stock.contains_key("0:0") && !saved.stock.contains_key("0:1"));
    }
}
