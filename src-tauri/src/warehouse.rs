//! Warehouse stock (R-326): products Jack physically holds, counted in boxes.
//!
//! One `warehouse_items` row per product. Its sections (a team, a size, a colour) are
//! `sections_json` = [{id, name, boxes, per_box}], so a section's units are always
//! boxes x per_box and no stored total can disagree with them. Every change to a box
//! count is written to `log_json` (newest first, capped at `LOG_CAP`) so "did we already
//! pull the Dodgers for that order?" has an answer.
//!
//! Stock leaves in two ways, both through `warehouse_adjust`: an invoice made from the
//! packer (the invoice form calls it once the invoice exists, so an abandoned invoice
//! takes nothing), and "Take out without an invoice". A count typed on the product itself
//! is logged as a `count` move by `save_warehouse_item`.
//!
//! The phone does the same through clienthub-api `routes/warehouse.rs`, which carries a
//! copy of `apply_changes` / `count_lines` — change both together.
//!
//! Synced as a whole row per column (last writer wins), so two devices changing the same
//! product's counts in the same minute keep the later one. One admin, one warehouse: an
//! accepted limit, written down rather than engineered around.

use crate::db::pool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const LOG_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Section {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub boxes: i64,
    #[serde(default)]
    pub per_box: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MoveLine {
    pub section_id: String,
    pub name: String,
    /// Signed: negative went out, positive came in.
    pub boxes: i64,
    pub units: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Move {
    pub id: String,
    pub at: String,
    /// "out" | "in" | "count"
    pub kind: String,
    pub lines: Vec<MoveLine>,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub undone: bool,
}

#[derive(Debug, Serialize)]
pub struct WarehouseItem {
    pub id: String,
    pub name: String,
    pub section_label: String,
    pub sections: Vec<Section>,
    pub boxes_per_pallet: i64,
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
    pub sections: Vec<Section>,
    #[serde(default)]
    pub boxes_per_pallet: i64,
    #[serde(default)]
    pub unit_price: f64,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Deserialize)]
pub struct Change {
    pub section_id: String,
    /// Signed: negative takes boxes out, positive puts them back.
    pub boxes: i64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Short {
    pub name: String,
    pub wanted: i64,
    pub taken: i64,
}

#[derive(Debug, Serialize)]
pub struct AdjustResult {
    pub item: WarehouseItem,
    /// Sections that held fewer boxes than asked for. Only what was there was taken.
    pub short: Vec<Short>,
}

const COLS: &str = "id, name, COALESCE(section_label,'Section'), COALESCE(sections_json,'[]'), \
    COALESCE(boxes_per_pallet,0), COALESCE(unit_price,0), COALESCE(notes,''), COALESCE(log_json,'[]'), \
    COALESCE(archived,0), created_at, updated_at";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<WarehouseItem> {
    let sections: String = r.get(3)?;
    let log: String = r.get(7)?;
    Ok(WarehouseItem {
        id: r.get(0)?,
        name: r.get(1)?,
        section_label: r.get(2)?,
        sections: serde_json::from_str(&sections).unwrap_or_default(),
        boxes_per_pallet: r.get(4)?,
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

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Clean what the form sent: trim names, drop blank rows that hold nothing, give new rows
/// an id, and refuse a section whose units cannot be counted.
pub fn clean_sections(input: Vec<Section>) -> Result<Vec<Section>, String> {
    let mut out = Vec::new();
    for s in input {
        let name = s.name.trim().to_string();
        let boxes = s.boxes.max(0);
        let per_box = s.per_box.max(0);
        if name.is_empty() {
            if boxes == 0 { continue; }
            return Err("Every row with boxes needs a name.".into());
        }
        if boxes > 0 && per_box < 1 {
            return Err(format!("Say how many units are in one box of {name}."));
        }
        let id = if s.id.trim().is_empty() { new_id() } else { s.id };
        out.push(Section { id, name, boxes, per_box });
    }
    Ok(out)
}

/// What changed between two versions of the sections, as signed move lines. A section
/// that was removed counts as going to zero.
pub fn count_lines(old: &[Section], new: &[Section]) -> Vec<MoveLine> {
    let mut lines = Vec::new();
    for n in new {
        let before = old.iter().find(|o| o.id == n.id).map(|o| o.boxes).unwrap_or(0);
        if n.boxes != before {
            let d = n.boxes - before;
            lines.push(MoveLine { section_id: n.id.clone(), name: n.name.clone(), boxes: d, units: d * n.per_box });
        }
    }
    for o in old {
        if o.boxes != 0 && !new.iter().any(|n| n.id == o.id) {
            lines.push(MoveLine { section_id: o.id.clone(), name: o.name.clone(), boxes: -o.boxes, units: -o.boxes * o.per_box });
        }
    }
    lines
}

/// Apply signed box changes. A section never goes below zero: asking for more than it
/// holds takes what is there and reports the shortfall.
pub fn apply_changes(sections: &mut [Section], changes: &[Change]) -> Result<(Vec<MoveLine>, Vec<Short>), String> {
    let mut lines = Vec::new();
    let mut short = Vec::new();
    for c in changes {
        if c.boxes == 0 { continue; }
        let s = sections
            .iter_mut()
            .find(|s| s.id == c.section_id)
            .ok_or_else(|| "A section on this pick is no longer on the product. Plan it again.".to_string())?;
        let applied = if c.boxes < 0 && -c.boxes > s.boxes {
            short.push(Short { name: s.name.clone(), wanted: -c.boxes, taken: s.boxes });
            -s.boxes
        } else {
            c.boxes
        };
        if applied == 0 { continue; }
        s.boxes += applied;
        lines.push(MoveLine { section_id: s.id.clone(), name: s.name.clone(), boxes: applied, units: applied * s.per_box });
    }
    Ok((lines, short))
}

pub fn kind_of(lines: &[MoveLine]) -> &'static str {
    if lines.iter().all(|l| l.boxes < 0) { "out" } else if lines.iter().all(|l| l.boxes > 0) { "in" } else { "count" }
}

pub fn push_log(log: &mut Vec<Move>, m: Move) {
    log.insert(0, m);
    log.truncate(LOG_CAP);
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

/// Create or update a product. A changed box count is logged as a `count` move.
#[tauri::command]
pub async fn save_warehouse_item(input: WarehouseInput) -> Result<WarehouseItem, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Give the product a name.".into());
    }
    let sections = clean_sections(input.sections)?;
    let label = match input.section_label.trim() { "" => "Section".to_string(), l => l.to_string() };
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;

    let existing = match input.id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(load(&conn, id)?),
        None => None,
    };
    let (id, mut log, old_sections) = match &existing {
        Some(e) => (e.id.clone(), e.log.clone(), e.sections.clone()),
        None => (uuid::Uuid::new_v4().to_string(), Vec::new(), Vec::new()),
    };
    let lines = count_lines(&old_sections, &sections);
    let log_changed = !lines.is_empty();
    if log_changed {
        let kind = if existing.is_none() { "in" } else { "count" };
        push_log(&mut log, Move { id: new_id(), at: now.clone(), kind: kind.into(), lines, reference: String::new(), note: String::new(), undone: false });
    }

    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("section_label".into(), json!(label));
    cols.insert("sections_json".into(), json_str(&sections));
    cols.insert("boxes_per_pallet".into(), json!(input.boxes_per_pallet.max(0)));
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
    write(&conn, &id, cols, existing.is_none())?;
    load(&conn, &id)
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

/// Move boxes in or out and log it. `undo_of` names the move being put back, which is
/// then marked undone so it cannot be put back twice.
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
    if let Some(u) = undo_of.as_deref() {
        match item.log.iter().find(|m| m.id == u) {
            Some(m) if m.undone => return Err("That move was already put back.".into()),
            Some(_) => {}
            None => return Err("That move is no longer in the history.".into()),
        }
    }
    let (lines, short) = apply_changes(&mut item.sections, &changes)?;
    if lines.is_empty() {
        return Err("Nothing to move — those sections have no boxes left.".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(u) = undo_of.as_deref() {
        if let Some(m) = item.log.iter_mut().find(|m| m.id == u) { m.undone = true; }
    }
    let kind = kind_of(&lines).to_string();
    push_log(&mut item.log, Move {
        id: new_id(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, boxes: i64, per_box: i64) -> Section {
        Section { id: id.into(), name: id.to_uppercase(), boxes, per_box }
    }

    #[test]
    fn a_pick_takes_what_is_there_and_names_the_shortfall() {
        let mut secs = vec![s("nyy", 10, 24), s("lad", 3, 24)];
        let (lines, short) = apply_changes(&mut secs, &[
            Change { section_id: "nyy".into(), boxes: -4 },
            Change { section_id: "lad".into(), boxes: -5 },
        ]).unwrap();
        assert_eq!(secs[0].boxes, 6);
        assert_eq!(secs[1].boxes, 0);
        assert_eq!(lines[0].units, -96);
        assert_eq!(lines[1].boxes, -3);
        assert_eq!(short, vec![Short { name: "LAD".into(), wanted: 5, taken: 3 }]);
        assert_eq!(kind_of(&lines), "out");
    }

    #[test]
    fn an_unknown_section_refuses_the_whole_pick() {
        let mut secs = vec![s("nyy", 10, 24)];
        assert!(apply_changes(&mut secs, &[Change { section_id: "gone".into(), boxes: -1 }]).is_err());
    }

    #[test]
    fn a_removed_section_counts_as_going_to_zero() {
        let old = vec![s("nyy", 10, 24), s("lad", 3, 12)];
        let new = vec![s("nyy", 12, 24)];
        let lines = count_lines(&old, &new);
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].boxes, lines[0].units), (2, 48));
        assert_eq!((lines[1].boxes, lines[1].units), (-3, -36));
    }

    #[test]
    fn a_section_with_boxes_must_say_its_units() {
        assert!(clean_sections(vec![Section { id: "".into(), name: "Mets".into(), boxes: 4, per_box: 0 }]).is_err());
        let ok = clean_sections(vec![
            Section { id: "".into(), name: "  Mets ".into(), boxes: 4, per_box: 24 },
            Section { id: "".into(), name: "".into(), boxes: 0, per_box: 0 },
        ]).unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].name, "Mets");
        assert!(!ok[0].id.is_empty());
    }

    #[test]
    fn the_log_keeps_the_newest_two_hundred() {
        let mut log = Vec::new();
        for i in 0..205 {
            push_log(&mut log, Move { id: i.to_string(), at: String::new(), kind: "in".into(), lines: vec![], reference: String::new(), note: String::new(), undone: false });
        }
        assert_eq!(log.len(), LOG_CAP);
        assert_eq!(log[0].id, "204");
    }

    /// End to end on the real schema: create, pick, put back, and the history says so.
    #[tokio::test]
    async fn save_pick_and_put_back() {
        crate::db::init_test_store();
        {
            let item = save_warehouse_item(WarehouseInput {
                id: None,
                name: "New Era 59FIFTY".into(),
                section_label: "Team".into(),
                sections: vec![
                    Section { id: String::new(), name: "Yankees".into(), boxes: 40, per_box: 24 },
                    Section { id: String::new(), name: "Dodgers".into(), boxes: 10, per_box: 24 },
                ],
                boxes_per_pallet: 20,
                unit_price: 9.0,
                notes: String::new(),
            }).await.unwrap();
            assert_eq!(item.log.len(), 1);
            assert_eq!(item.log[0].kind, "in");
            let nyy = item.sections[0].id.clone();

            let r = warehouse_adjust(item.id.clone(), vec![Change { section_id: nyy.clone(), boxes: -15 }],
                Some("INV-1001".into()), None, None).await.unwrap();
            assert_eq!(r.item.sections[0].boxes, 25);
            assert_eq!(r.item.log[0].kind, "out");
            assert_eq!(r.item.log[0].reference, "INV-1001");

            let pick_id = r.item.log[0].id.clone();
            let back = warehouse_adjust(item.id.clone(), vec![Change { section_id: nyy.clone(), boxes: 15 }],
                None, Some("Put back".into()), Some(pick_id.clone())).await.unwrap();
            assert_eq!(back.item.sections[0].boxes, 40);
            assert!(back.item.log.iter().find(|m| m.id == pick_id).unwrap().undone);
            assert!(warehouse_adjust(item.id.clone(), vec![Change { section_id: nyy, boxes: 15 }],
                None, None, Some(pick_id)).await.is_err());

            // A typed recount is logged, not silently overwritten.
            let mut secs = back.item.sections.clone();
            secs[1].boxes = 12;
            let saved = save_warehouse_item(WarehouseInput {
                id: Some(item.id.clone()), name: item.name.clone(), section_label: "Team".into(),
                sections: secs, boxes_per_pallet: 20, unit_price: 9.0, notes: String::new(),
            }).await.unwrap();
            assert_eq!(saved.log[0].kind, "count");
            assert_eq!(saved.log[0].lines[0].boxes, 2);
        }
    }
}
