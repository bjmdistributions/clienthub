//! A delivery coming in, and every case received onto its pallets (R-519).
//!
//! One `warehouse_loads` row per delivery, its manifest as read in `lines_json`, and one
//! `warehouse_cases` row per case, so two devices receiving at once never overwrite each other.
//! Reading a manifest, checking a case and every count are `case_core.rs`, byte-identical on
//! the server (clienthub-api `routes/case_core.rs`, behind `routes/warehouse_loads.rs`): this
//! file is only storage, sync and the Tauri commands. Removed rows are archived, never deleted.

use crate::case_core::{self as core, Case, CaseLine, LoadLine, ManifestRead, Out, PalletRecord, PalletView, Stock, Tally, TakeShort, Totals};
use crate::db::pool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const LOADS: &str = "warehouse_loads";
const CASES: &str = "warehouse_cases";
const OUTS: &str = "warehouse_load_outs";
const PALLETS: &str = "warehouse_load_pallets";

#[derive(Debug, Serialize)]
pub struct LoadHead {
    pub id: String,
    pub name: String,
    pub source: String,
    pub notes: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
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
}

struct LoadRow {
    head: LoadHead,
    lines: Vec<LoadLine>,
}

const LOAD_COLS: &str = "id, name, COALESCE(source,''), COALESCE(notes,''), COALESCE(lines_json,'[]'), COALESCE(archived,0), created_at, updated_at";

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
            lines: None,
        },
        lines: serde_json::from_str(&lines).unwrap_or_default(),
    })
}

fn load(conn: &rusqlite::Connection, id: &str) -> Result<LoadRow, String> {
    conn.query_row(&format!("SELECT {LOAD_COLS} FROM warehouse_loads WHERE id = ?1"), [id], map_load)
        .map_err(|_| "That delivery is no longer there.".to_string())
}

fn cases(conn: &rusqlite::Connection, load_id: &str) -> Result<Vec<Case>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(pallet,1), COALESCE(number,1), COALESCE(contents_json,'[]'), COALESCE(notes,''), created_at, updated_at, COALESCE(kind,'box') \
             FROM warehouse_cases WHERE load_id = ?1 AND COALESCE(archived,0) = 0 ORDER BY pallet, number, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([load_id], |r| {
            let contents: String = r.get(3)?;
            Ok(Case {
                id: r.get(0)?,
                pallet: r.get(1)?,
                number: r.get(2)?,
                contents: serde_json::from_str(&contents).unwrap_or_default(),
                notes: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                kind: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// A delivery's pallet records (R-535), not removed ones.
fn pallet_records(conn: &rusqlite::Connection, load_id: &str) -> Result<Vec<PalletRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(number,0), COALESCE(location,''), COALESCE(closed,0), COALESCE(note,''), created_at, updated_at \
             FROM warehouse_load_pallets WHERE load_id = ?1 AND COALESCE(archived,0) = 0 ORDER BY number",
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

/// The columns of a new pallet record: only what a new pallet needs. Location, full and note are
/// left to the schema's defaults, so a create from a device that had not yet seen this pallet can
/// never blank a location another device set (last writer wins per column).
fn pallet_cols(load_id: &str, number: i64, t: &str) -> Map<String, Value> {
    let mut cols = Map::new();
    cols.insert("load_id".into(), json!(load_id));
    cols.insert("number".into(), json!(number));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    cols
}

/// Whether a pallet row exists at all, removed ones included (its id is fixed by its number).
fn pallet_row_exists(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row("SELECT COUNT(*) FROM warehouse_load_pallets WHERE id = ?1", [id], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
}

/// Write a new pallet, or bring a removed one with that number back.
fn put_new_pallet(conn: &rusqlite::Connection, load_id: &str, number: i64, t: &str) -> Result<(), String> {
    let pid = core::pallet_id(load_id, number);
    if pallet_row_exists(conn, &pid) {
        let mut cols = Map::new();
        cols.insert("archived".into(), json!(0));
        cols.insert("updated_at".into(), json!(t));
        write(conn, PALLETS, &pid, cols, false)
    } else {
        write(conn, PALLETS, &pid, pallet_cols(load_id, number, t), true)
    }
}

fn outs(conn: &rusqlite::Connection, load_id: &str) -> Result<Vec<Out>, String> {
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
    Ok(LoadDetail { load: head, cases: cs, tally, outs, stock, short: None, pallets, recent_locations: recent_locations(conn) })
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

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
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
        out.push(LoadSummary { id: h.id, name: h.name, source: h.source, notes: h.notes, archived: h.archived, created_at: h.created_at, updated_at: h.updated_at, totals });
    }
    Ok(out)
}

/// A manifest read for the preview. Nothing is saved.
#[tauri::command]
pub async fn read_load_manifest(path: String) -> Result<ManifestRead, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the file: {e}"))?;
    let tabs = core::read_tabs(&path, &bytes)?;
    Ok(core::read_manifest(&tabs))
}

#[tauri::command]
pub async fn get_warehouse_load(id: String) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    detail(&conn, &id, true)
}

#[tauri::command]
pub async fn create_warehouse_load(name: String, source: String, lines: Vec<LoadLine>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the delivery a name.".into());
    }
    let lines = core::clean_lines(lines)?;
    let id = uuid::Uuid::new_v4().to_string();
    let t = now();
    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("source".into(), json!(source.trim()));
    cols.insert("notes".into(), json!(""));
    cols.insert("lines_json".into(), json_str(&lines));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    write(&conn, LOADS, &id, cols, true)?;
    // R-535: pallet 1 stands empty, ready for the truck.
    write(&conn, PALLETS, &core::pallet_id(&id, 1), pallet_cols(&id, 1, &t), true)?;
    detail(&conn, &id, true)
}

/// Rename a delivery, note it, remove it (archived, never deleted) or bring it back.
#[tauri::command]
pub async fn update_warehouse_load(id: String, name: Option<String>, notes: Option<String>, archived: Option<bool>) -> Result<LoadDetail, String> {
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
    });
    let lines = core::clean_lines(lines)?;
    let mut cols = Map::new();
    cols.insert("lines_json".into(), json_str(&lines));
    cols.insert("updated_at".into(), json!(now()));
    write(&conn, LOADS, &id, cols, false)?;
    detail(&conn, &id, true)
}

/// Save a case: a new one (and as many identical copies as asked), or a change to one saved.
#[tauri::command]
pub async fn save_warehouse_case(load_id: String, case_id: Option<String>, pallet: i64, contents: Vec<CaseLine>, notes: Option<String>, copies: Option<i64>, kind: Option<String>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if !(1..=999).contains(&pallet) {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    let copies = copies.unwrap_or(1);
    if !(1..=core::MAX_COPIES).contains(&copies) {
        return Err(format!("Save between 1 and {} cases at once.", core::MAX_COPIES));
    }
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let contents = core::clean_contents(&l.lines, &contents)?;
    let notes = notes.unwrap_or_default().trim().to_string();
    let mut have = cases(&conn, &load_id)?;
    let t = now();
    match case_id.as_deref().filter(|s| !s.is_empty()) {
        Some(cid) => {
            let old = have.iter().find(|c| c.id == cid).cloned().ok_or("That case is no longer there.")?;
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
            cols.insert("notes".into(), json!(notes));
            cols.insert("updated_at".into(), json!(t));
            write(&conn, CASES, cid, cols, false)?;
        }
        None => {
            // R-535: loose items on the pallet are one row with no box number.
            let loose = kind.as_deref() == Some("loose");
            for _ in 0..(if loose { 1 } else { copies }) {
                let number = if loose { 0 } else { core::next_number(&have, pallet, "") };
                let cid = uuid::Uuid::new_v4().to_string();
                let mut cols = Map::new();
                cols.insert("load_id".into(), json!(load_id));
                cols.insert("pallet".into(), json!(pallet));
                cols.insert("number".into(), json!(number));
                cols.insert("contents_json".into(), json_str(&contents));
                cols.insert("notes".into(), json!(notes));
                cols.insert("kind".into(), json!(if loose { "loose" } else { "box" }));
                cols.insert("archived".into(), json!(0));
                cols.insert("created_at".into(), json!(t));
                cols.insert("updated_at".into(), json!(t));
                write(&conn, CASES, &cid, cols, true)?;
                have.push(Case { id: cid, pallet, number, kind: if loose { "loose".into() } else { "box".into() }, ..Default::default() });
            }
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
pub async fn take_load_pairs(load_id: String, invoice_id: Option<String>, reference: Option<String>, note: Option<String>, takes: Vec<CaseLine>) -> Result<LoadDetail, String> {
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
    let (taken, short) = core::take(&l.lines, &cs, &os, &takes)?;
    if !taken.is_empty() {
        let t = now();
        let mut cols = Map::new();
        cols.insert("load_id".into(), json!(load_id));
        cols.insert("invoice_id".into(), json!(invoice_id));
        cols.insert("reference".into(), json!(reference.unwrap_or_default().trim()));
        cols.insert("note".into(), json!(note.unwrap_or_default().trim()));
        cols.insert("pairs".into(), json!(taken.iter().map(|x| x.pairs).sum::<i64>()));
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
    }
    detail(&conn, &load_id, false)
}

/// Start the next pallet, empty (R-535). Its number is one more than any pallet the delivery has.
#[tauri::command]
pub async fn start_load_pallet(load_id: String) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
    let n = core::next_pallet(&pallet_records(&conn, &load_id)?, &cases(&conn, &load_id)?);
    if n > 999 {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    put_new_pallet(&conn, &load_id, n, &now())?;
    detail(&conn, &load_id, false)
}

/// Where a pallet stands, its note, full or not (R-535). The record is made the first time any of
/// them is set; "Pallet full" can also start the next pallet.
#[tauri::command]
pub async fn save_load_pallet(load_id: String, number: i64, location: Option<String>, note: Option<String>, closed: Option<bool>, start_next: Option<bool>, archived: Option<bool>) -> Result<LoadDetail, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    if !(1..=999).contains(&number) {
        return Err("Pallet numbers run from 1 to 999.".into());
    }
    let l = load(&conn, &load_id)?;
    if l.head.archived {
        return Err("This delivery was removed. Bring it back first.".into());
    }
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
    cols.insert("updated_at".into(), json!(t));
    write(&conn, PALLETS, &pid, cols, !exists)?;
    if start_next {
        let n = core::next_pallet(&pallet_records(&conn, &load_id)?, &have);
        if n <= 999 {
            put_new_pallet(&conn, &load_id, n, &t)?;
        }
    }
    detail(&conn, &load_id, false)
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

    /// A delivery saved, cases added (three copies, one moved, one removed), a style added by
    /// hand, and every count read back from the stored rows.
    #[tokio::test]
    async fn a_delivery_receives_cases_onto_pallets() {
        let _db = crate::db::init_test_store();
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4), ("8", 2)]), line("b", "K2", &[("S", 3)])]).await.unwrap();
        let id = d.load.id.clone();
        assert_eq!(d.tally.totals.expected, 9);
        let c = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }, CaseLine { line_id: "b".into(), size: "S".into(), pairs: 1 }];
        let d = save_warehouse_case(id.clone(), None, 1, c.clone(), None, Some(3), None).await.unwrap();
        assert!(d.load.lines.is_none());
        assert_eq!(d.cases.iter().map(|x| (x.pallet, x.number)).collect::<Vec<_>>(), vec![(1, 1), (1, 2), (1, 3)]);
        assert_eq!(d.tally.totals.received, 9);
        let moved = d.cases[1].id.clone();
        let d = save_warehouse_case(id.clone(), Some(moved.clone()), 2, c.clone(), Some("dented".into()), None, None).await.unwrap();
        let m = d.cases.iter().find(|x| x.id == moved).unwrap();
        assert_eq!((m.pallet, m.number, m.notes.as_str()), (2, 1, "dented"));
        let d = remove_warehouse_case(id.clone(), d.cases[0].id.clone()).await.unwrap();
        assert_eq!(d.cases.len(), 2);
        assert_eq!(d.tally.totals.received, 6);
        assert!(save_warehouse_case(id.clone(), None, 1, vec![CaseLine { line_id: "a".into(), size: "12".into(), pairs: 1 }], None, None, None).await.is_err());
        let d = add_warehouse_load_line(id.clone(), NewLine { style: "X9".into(), sizes: "5, 6".into(), brand: "Acme".into(), group: String::new(), color: String::new(), description: String::new(), cost: 0.0, msrp: 0.0 }).await.unwrap();
        assert_eq!(d.load.lines.as_ref().unwrap().len(), 3);
        let d = update_warehouse_load(id.clone(), None, None, Some(true)).await.unwrap();
        assert!(d.load.archived);
        assert!(save_warehouse_case(id.clone(), None, 1, c, None, None, None).await.is_err());
        let all = list_warehouse_loads().await.unwrap();
        assert!(all.iter().any(|x| x.id == id && x.totals.cases == 2));
    }

    /// R-519 phase 2: an invoice's pairs leave the delivery once, a retry takes nothing twice,
    /// a case edit cannot undercut a sale, and Put back returns the pairs.
    #[tokio::test]
    async fn an_order_takes_pairs_once_and_put_back_returns_them() {
        let _db = crate::db::init_test_store();
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4), ("8", 2)])]).await.unwrap();
        let id = d.load.id.clone();
        let c = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 3 }, CaseLine { line_id: "a".into(), size: "8".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), None, 1, c, None, None, None).await.unwrap();
        let case_id = d.cases[0].id.clone();
        assert_eq!(d.stock.left, 5);
        let want = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }, CaseLine { line_id: "a".into(), size: "8".into(), pairs: 5 }];
        let d = take_load_pairs(id.clone(), Some("inv1".into()), Some("INV-1".into()), None, want.clone()).await.unwrap();
        assert_eq!(d.stock.left, 1);
        assert_eq!(d.short.as_ref().unwrap().len(), 1);
        assert_eq!(d.outs.len(), 1);
        assert_eq!((d.outs[0].out.pairs, d.outs[0].out.cost, d.outs[0].invoice_state), (4, 40.0, "gone"));
        // The same invoice again takes nothing more.
        let d = take_load_pairs(id.clone(), Some("inv1".into()), Some("INV-1".into()), None, want).await.unwrap();
        assert_eq!((d.stock.left, d.outs.len()), (1, 1));
        // Cutting the case below what was sold is refused; so is removing it.
        let less = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 1 }];
        assert!(save_warehouse_case(id.clone(), Some(case_id.clone()), 1, less, None, None, None).await.is_err());
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
        let d = create_warehouse_load("Truck".into(), "t.xlsx".into(), vec![line("a", "K1", &[("7", 4), ("8", 2)])]).await.unwrap();
        let id = d.load.id.clone();
        assert_eq!(d.pallets.iter().map(|p| (p.pallet, p.recorded, p.pairs)).collect::<Vec<_>>(), vec![(1, true, 0)]);
        let loose = vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), None, 1, loose, None, Some(5), Some("loose".into())).await.unwrap();
        assert_eq!(d.cases.len(), 1);
        assert_eq!((d.cases[0].number, d.cases[0].kind.as_str()), (0, "loose"));
        let boxed = vec![CaseLine { line_id: "a".into(), size: "8".into(), pairs: 2 }];
        let d = save_warehouse_case(id.clone(), None, 1, boxed, None, None, None).await.unwrap();
        let b = d.cases.iter().find(|c| !c.is_loose()).unwrap();
        assert_eq!(b.number, 1);
        assert_eq!((d.pallets[0].boxes, d.pallets[0].loose, d.pallets[0].pairs), (1, 2, 4));
        let d = save_load_pallet(id.clone(), 1, Some("  Dock door ".into()), None, Some(true), Some(true), None).await.unwrap();
        assert_eq!(d.pallets.iter().map(|p| (p.pallet, p.location.as_str(), p.closed)).collect::<Vec<_>>(), vec![(1, "Dock door", true), (2, "", false)]);
        assert_eq!(d.recent_locations, vec!["Dock door".to_string()]);
        // A second Pallet full on 1 (a retry) starts nothing more.
        let d = save_load_pallet(id.clone(), 1, None, None, Some(true), Some(true), None).await.unwrap();
        assert_eq!(d.pallets.len(), 2);
        let d = start_load_pallet(id.clone()).await.unwrap();
        assert_eq!(d.pallets.last().unwrap().pallet, 3);
        assert_eq!(d.tally.totals.cases, 1);
        // An empty pallet can be removed and its number comes back with the next start; one with boxes cannot.
        let d = save_load_pallet(id.clone(), 3, None, None, None, None, Some(true)).await.unwrap();
        assert_eq!(d.pallets.len(), 2);
        assert!(save_load_pallet(id.clone(), 1, None, None, None, None, Some(true)).await.is_err());
        let d = start_load_pallet(id.clone()).await.unwrap();
        assert_eq!(d.pallets.iter().map(|p| p.pallet).collect::<Vec<_>>(), vec![1, 2, 3]);
    }
}
