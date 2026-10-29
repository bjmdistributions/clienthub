//! R-564: saved manifests, the category rules Jack set, and how each supplier's columns were read.
//!
//! Three synced tables (db.rs migration 121). A manifest keeps its lines and its rolled up products
//! in `lines_json` and `products_json`: one writer, once, so one sync event rather than one per line.
//! Delete is archive and can be undone, nothing here destroys a row. Every write goes through
//! `warehouse_loads::write`, which writes the row and records it for sync in one step.

use crate::case_core::{LoadLine, SizeQty};
use crate::db::pool;
use crate::warehouse_loads::{now, write};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const MANIFESTS: &str = "manifests";
const RULES: &str = "manifest_rules";
const MAPS: &str = "manifest_column_maps";

/// The rule kinds the reader understands (manifest_split ReadOptions rules).
/// The most of `lines_json` and `products_json` a sync event may carry: the sync push route takes
/// 32 MB a request. Over the cap the event carries "[]" and the local row keeps the full text, because
/// other devices re-read the manifest from its file, which reaches the server as media.
const MAX_SYNC_LINES: usize = 6 * 1024 * 1024;
const MAX_SYNC_PRODUCTS: usize = 2 * 1024 * 1024;

const RULE_KINDS: [&str; 5] = ["word", "phrase", "upc_prefix", "sheet_category", "brand_word"];

/// The JSON columns of `manifests`, stored as text and returned parsed under the name without `_json`.
const JSON_COLS: [&str; 8] = ["pages", "sections", "column_map", "options", "totals", "stated", "lines", "products"];

/// What the screen sends to save a manifest. Each JSON part may come as a value or as the stored
/// `*_json` name. `id` set means a re-save of that manifest (a re-read with today's rules).
#[derive(Debug, Default, Deserialize)]
pub struct ManifestRecord {
    #[serde(default)]
    pub id: Option<String>,
    /// The file as it sits now. It is copied under the app's synced media folder.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub supplier: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub ask: Option<f64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, alias = "pages_json")]
    pub pages: Option<Value>,
    #[serde(default, alias = "sections_json")]
    pub sections: Option<Value>,
    #[serde(default, alias = "column_map_json")]
    pub column_map: Option<Value>,
    #[serde(default, alias = "options_json")]
    pub options: Option<Value>,
    #[serde(default, alias = "totals_json")]
    pub totals: Option<Value>,
    #[serde(default, alias = "stated_json")]
    pub stated: Option<Value>,
    #[serde(default, alias = "lines_json")]
    pub lines: Option<Value>,
    #[serde(default, alias = "products_json")]
    pub products: Option<Value>,
}

/// One rule, the same fields as the reader's `Rule`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ManifestRule {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn parsed(s: String, fallback: Value) -> Value {
    if s.trim().is_empty() {
        return fallback;
    }
    serde_json::from_str(&s).unwrap_or(fallback)
}

fn fallback_for(col: &str) -> Value {
    match col {
        "column_map" | "options" | "totals" | "stated" => json!({}),
        _ => json!([]),
    }
}

/// The columns a list row carries: everything but the two big ones.
const LIGHT_COLS: &str = "id, COALESCE(name,''), COALESCE(supplier,''), COALESCE(source_name,''), COALESCE(file_ref,''), \
    COALESCE(pages_json,'[]'), COALESCE(sections_json,'[]'), COALESCE(column_map_json,'{}'), COALESCE(options_json,'{}'), \
    COALESCE(totals_json,'{}'), COALESCE(stated_json,'{}'), COALESCE(ask,0), COALESCE(status,''), COALESCE(lot_id,''), \
    COALESCE(load_id,''), COALESCE(created_at,''), COALESCE(updated_at,''), COALESCE(archived,0), \
    CASE WHEN json_valid(lines_json) THEN json_array_length(lines_json) ELSE 0 END, \
    CASE WHEN json_valid(products_json) THEN json_array_length(products_json) ELSE 0 END";

/// The absolute path of the kept file when it is on this device, else null.
fn kept_path(file_ref: &str) -> Value {
    if file_ref.is_empty() {
        return Value::Null;
    }
    let p = crate::db::app_data_dir().join("sync").join(file_ref);
    if p.is_file() { json!(p.to_string_lossy()) } else { Value::Null }
}

fn light_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "name": r.get::<_, String>(1)?,
        "supplier": r.get::<_, String>(2)?,
        "source_name": r.get::<_, String>(3)?,
        "file_ref": r.get::<_, String>(4)?,
        "file_path": kept_path(&r.get::<_, String>(4)?),
        "pages": parsed(r.get(5)?, json!([])),
        "sections": parsed(r.get(6)?, json!([])),
        "column_map": parsed(r.get(7)?, json!({})),
        "options": parsed(r.get(8)?, json!({})),
        "totals": parsed(r.get(9)?, json!({})),
        "stated": parsed(r.get(10)?, json!({})),
        "ask": r.get::<_, f64>(11)?,
        "status": r.get::<_, String>(12)?,
        "lot_id": r.get::<_, String>(13)?,
        "load_id": r.get::<_, String>(14)?,
        "created_at": r.get::<_, String>(15)?,
        "updated_at": r.get::<_, String>(16)?,
        "archived": r.get::<_, i64>(17)? != 0,
        "line_count": r.get::<_, i64>(18)?,
        "product_count": r.get::<_, i64>(19)?,
    }))
}

fn list(archived: bool) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {LIGHT_COLS} FROM {MANIFESTS} WHERE COALESCE(archived,0) = ?1 ORDER BY updated_at DESC, created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([archived as i64], light_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Not archived, newest first, without the lines or the products.
#[tauri::command]
pub async fn list_manifests() -> Result<Vec<Value>, String> {
    list(false)
}

/// The ones taken off the list, newest first, so one can be brought back.
#[tauri::command]
pub async fn list_manifests_deleted() -> Result<Vec<Value>, String> {
    list(true)
}

fn get(conn: &rusqlite::Connection, id: &str) -> Result<Value, String> {
    let mut v = conn
        .query_row(&format!("SELECT {LIGHT_COLS} FROM {MANIFESTS} WHERE id = ?1"), [id], light_row)
        .map_err(|_| "That manifest is no longer there.".to_string())?;
    let (lines, products): (String, String) = conn
        .query_row(
            &format!("SELECT COALESCE(lines_json,'[]'), COALESCE(products_json,'[]') FROM {MANIFESTS} WHERE id = ?1"),
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    v["lines"] = parsed(lines, json!([]));
    v["products"] = parsed(products, json!([]));
    Ok(v)
}

/// One manifest with its lines and products.
#[tauri::command]
pub async fn get_manifest(id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    get(&conn, &id)
}

/// Copy the source file under `media/manifests/<id>/<file name>` in the synced folder and return that
/// relative path. A file already there (a re-save) is left alone. The caller queues it for the server
/// (`netsync::media_enqueue`, kind "manifestfile").
fn keep_file(id: &str, src: &str) -> Result<String, String> {
    let src_path = std::path::Path::new(src);
    if !src_path.is_file() {
        return Err("Could not find that file to keep.".into());
    }
    let fname = src_path.file_name().and_then(|f| f.to_str()).unwrap_or("manifest");
    let rel = format!("media/manifests/{id}/{fname}");
    let dest = crate::db::app_data_dir().join("sync").join(&rel);
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't keep the file: {e}"))?;
    }
    let same = match (std::fs::canonicalize(src_path), std::fs::canonicalize(&dest)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same {
        std::fs::copy(src_path, &dest).map_err(|e| format!("Couldn't keep the file: {e}"))?;
    }
    Ok(rel)
}

/// Save a manifest: the file is kept, the row is written, and its lines and products go with it in
/// one write. With `id` of an existing manifest it is a re-save of that one.
#[tauri::command]
pub async fn save_manifest(record: ManifestRecord) -> Result<Value, String> {
    let existing = record.id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let conn = pool().get().map_err(|e| e.to_string())?;
    let create = match &existing {
        Some(id) => conn.query_row(&format!("SELECT 1 FROM {MANIFESTS} WHERE id=?1"), [id], |_| Ok(())).is_err(),
        None => true,
    };
    let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let t = now();
    let mut cols = Map::new();

    if let Some(p) = record.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        let rel = keep_file(&id, p)?;
        // R-564: the file reaches the server (and from there the phone and every other device) through the
        // durable media queue, keyed by the manifest id. Queued again on every save: it is idempotent by path
        // and the queue drops it once the server has the file.
        crate::netsync::media_enqueue(&id, &rel, "manifestfile");
        cols.insert("file_ref".into(), json!(rel));
        if record.source_name.is_none() {
            let n = std::path::Path::new(p).file_name().and_then(|f| f.to_str()).unwrap_or("");
            cols.insert("source_name".into(), json!(n));
        }
    }
    if let Some(s) = &record.source_name {
        cols.insert("source_name".into(), json!(s.trim()));
    }
    if let Some(n) = &record.name {
        cols.insert("name".into(), json!(n.trim()));
    }
    if let Some(s) = &record.supplier {
        cols.insert("supplier".into(), json!(s.trim()));
    }
    if let Some(a) = record.ask {
        cols.insert("ask".into(), json!(if a.is_finite() { a.max(0.0) } else { 0.0 }));
    }
    if let Some(s) = &record.status {
        cols.insert("status".into(), json!(s.trim()));
    }
    for (name, v) in [
        ("pages", &record.pages), ("sections", &record.sections), ("column_map", &record.column_map),
        ("options", &record.options), ("totals", &record.totals), ("stated", &record.stated),
        ("lines", &record.lines), ("products", &record.products),
    ] {
        if let Some(v) = v {
            cols.insert(format!("{name}_json"), json!(text(v)));
        }
    }

    if create {
        // A create event carries every column (sync-engine rule 3), so none is left out.
        let source = cols.get("source_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut name = cols.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            name = if source.is_empty() { "Manifest".into() } else { source };
        }
        cols.insert("name".into(), json!(name));
        for (k, d) in [
            ("supplier", json!("")), ("source_name", json!("")), ("file_ref", json!("")), ("ask", json!(0)),
            ("status", json!("saved")), ("lot_id", json!("")), ("load_id", json!("")),
            ("archived", json!(0)),
        ] {
            cols.entry(k.to_string()).or_insert(d);
        }
        for c in JSON_COLS {
            cols.entry(format!("{c}_json")).or_insert_with(|| json!(text(&fallback_for(c))));
        }
        cols.insert("created_at".into(), json!(t));
    } else if let Some(n) = cols.get("name").and_then(|v| v.as_str()) {
        if n.trim().is_empty() {
            return Err("Give the manifest a name.".into());
        }
    }
    cols.insert("updated_at".into(), json!(t));
    // The sync event carries "[]" for a part over its cap and the local row keeps it in full.
    let mut left_out: Vec<(&str, String)> = Vec::new();
    let mut sync_cols = cols;
    for (col, cap) in [("lines_json", MAX_SYNC_LINES), ("products_json", MAX_SYNC_PRODUCTS)] {
        if sync_cols.get(col).and_then(|v| v.as_str()).map_or(false, |t| t.len() > cap) {
            if let Some(Value::String(full)) = sync_cols.insert(col.into(), json!("[]")) {
                left_out.push((col, full));
            }
        }
    }
    write(&conn, MANIFESTS, &id, sync_cols, create)?;
    for (col, full) in left_out {
        conn.execute(&format!("UPDATE {MANIFESTS} SET {col}=?1 WHERE id=?2"), rusqlite::params![full, id])
            .map_err(|e| e.to_string())?;
    }
    get(&conn, &id)
}

/// Rename a manifest, change the ask, or take it off the list (archived) or bring it back.
#[tauri::command]
pub async fn update_manifest(id: String, name: Option<String>, ask: Option<f64>, archived: Option<bool>) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    get(&conn, &id)?;
    let mut cols = Map::new();
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err("Give the manifest a name.".into());
        }
        cols.insert("name".into(), json!(n));
    }
    if let Some(a) = ask {
        if !a.is_finite() || a < 0.0 {
            return Err("Enter the ask as a number.".into());
        }
        cols.insert("ask".into(), json!(a));
    }
    if let Some(a) = archived {
        cols.insert("archived".into(), json!(a as i64));
    }
    if !cols.is_empty() {
        cols.insert("updated_at".into(), json!(now()));
        write(&conn, MANIFESTS, &id, cols, false)?;
    }
    get(&conn, &id)
}

/// Delete is archive: the manifest leaves the list and can be brought back.
#[tauri::command]
pub async fn delete_manifest(id: String) -> Result<Value, String> {
    update_manifest(id, None, None, Some(true)).await
}

#[tauri::command]
pub async fn restore_manifest(id: String) -> Result<Value, String> {
    update_manifest(id, None, None, Some(false)).await
}

/// Record where a manifest went: the lot it made on Inventory and the delivery it made on the Warehouse.
#[tauri::command]
pub async fn set_manifest_links(id: String, lot_id: Option<String>, load_id: Option<String>) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    get(&conn, &id)?;
    set_links(&conn, &id, lot_id, load_id)?;
    get(&conn, &id)
}

fn set_links(conn: &rusqlite::Connection, id: &str, lot_id: Option<String>, load_id: Option<String>) -> Result<(), String> {
    let mut cols = Map::new();
    if let Some(l) = lot_id {
        cols.insert("lot_id".into(), json!(l.trim()));
    }
    if let Some(l) = load_id {
        cols.insert("load_id".into(), json!(l.trim()));
    }
    if cols.is_empty() {
        return Ok(());
    }
    cols.insert("updated_at".into(), json!(now()));
    write(conn, MANIFESTS, id, cols, false)
}

// ---------------------------------------------------------------------------------------
//  Rules
// ---------------------------------------------------------------------------------------

fn rule_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let (category, brand): (String, String) = (r.get(3)?, r.get(4)?);
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "kind": r.get::<_, String>(1)?,
        "pattern": r.get::<_, String>(2)?,
        "category": if category.is_empty() { Value::Null } else { json!(category) },
        "brand": if brand.is_empty() { Value::Null } else { json!(brand) },
        "source": r.get::<_, String>(5)?,
        "created_at": r.get::<_, String>(6)?,
        "updated_at": r.get::<_, String>(7)?,
    }))
}

const RULE_COLS: &str = "id, COALESCE(kind,''), COALESCE(pattern,''), COALESCE(category,''), COALESCE(brand,''), COALESCE(source,''), COALESCE(created_at,''), COALESCE(updated_at,'')";

fn live_rules(conn: &rusqlite::Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {RULE_COLS} FROM {RULES} WHERE COALESCE(archived,0)=0 ORDER BY created_at, id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], rule_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_manifest_rules() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    live_rules(&conn)
}

/// Save rules, by id. A blank id gets a new one, unless a live rule already says the same thing
/// (same kind and pattern, ignoring case), which is then changed instead of doubled. Returns every
/// live rule after the save.
#[tauri::command]
pub async fn save_manifest_rules(rules: Vec<ManifestRule>) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let t = now();
    for r in rules {
        let kind = r.kind.trim().to_lowercase();
        if !RULE_KINDS.contains(&kind.as_str()) {
            return Err(format!("{} is not a kind of rule.", r.kind.trim()));
        }
        let pattern = r.pattern.trim().to_string();
        if pattern.is_empty() {
            return Err("A rule needs a word, a phrase or a code to match.".into());
        }
        let category = r.category.as_deref().map(str::trim).unwrap_or("").to_string();
        let brand = r.brand.as_deref().map(str::trim).unwrap_or("").to_string();
        if category.is_empty() && brand.is_empty() {
            return Err(format!("Pick a category or a brand for {pattern}."));
        }
        let mut id = r.id.trim().to_string();
        if id.is_empty() {
            id = conn
                .query_row(
                    &format!("SELECT id FROM {RULES} WHERE COALESCE(archived,0)=0 AND kind=?1 AND lower(pattern)=lower(?2) LIMIT 1"),
                    rusqlite::params![kind, pattern],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_default();
        }
        let create = id.is_empty() || conn.query_row(&format!("SELECT 1 FROM {RULES} WHERE id=?1"), [&id], |_| Ok(())).is_err();
        if id.is_empty() {
            id = uuid::Uuid::new_v4().to_string();
        }
        let mut cols = Map::new();
        cols.insert("kind".into(), json!(kind));
        cols.insert("pattern".into(), json!(pattern));
        cols.insert("category".into(), json!(category));
        cols.insert("brand".into(), json!(brand));
        cols.insert("archived".into(), json!(0));
        cols.insert("updated_at".into(), json!(t));
        if create {
            cols.insert("source".into(), json!("review"));
            cols.insert("created_at".into(), json!(t));
        }
        write(&conn, RULES, &id, cols, create)?;
    }
    live_rules(&conn)
}

/// A rule is archived, never destroyed.
#[tauri::command]
pub async fn delete_manifest_rule(id: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(&format!("SELECT 1 FROM {RULES} WHERE id=?1"), [&id], |_| Ok(()))
        .map_err(|_| "That rule is no longer there.".to_string())?;
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(1));
    cols.insert("updated_at".into(), json!(now()));
    write(&conn, RULES, &id, cols, false)?;
    live_rules(&conn)
}

// ---------------------------------------------------------------------------------------
//  Column maps
// ---------------------------------------------------------------------------------------

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "signature": r.get::<_, String>(1)?,
        "name": r.get::<_, String>(2)?,
        "map": parsed(r.get(3)?, json!({})),
        "created_at": r.get::<_, String>(4)?,
        "updated_at": r.get::<_, String>(5)?,
    }))
}

const MAP_COLS: &str = "id, COALESCE(signature,''), COALESCE(name,''), COALESCE(map_json,'{}'), COALESCE(created_at,''), COALESCE(updated_at,'')";

/// How this header was read before, if it was. The newest map for the signature.
#[tauri::command]
pub async fn find_column_map(signature: String) -> Result<Option<Value>, String> {
    let sig = signature.trim();
    if sig.is_empty() {
        return Ok(None);
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(conn
        .query_row(
            &format!("SELECT {MAP_COLS} FROM {MAPS} WHERE COALESCE(archived,0)=0 AND signature=?1 ORDER BY updated_at DESC LIMIT 1"),
            [sig],
            map_row,
        )
        .ok())
}

/// Remember how a header was read. One map per signature: saving again changes it.
#[tauri::command]
pub async fn save_column_map(signature: String, name: String, map_json: Value) -> Result<Value, String> {
    let sig = signature.trim().to_string();
    if sig.is_empty() {
        return Err("There is no header to remember the columns for.".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let found: Option<String> = conn
        .query_row(
            &format!("SELECT id FROM {MAPS} WHERE COALESCE(archived,0)=0 AND signature=?1 ORDER BY updated_at DESC LIMIT 1"),
            [&sig],
            |r| r.get(0),
        )
        .ok();
    let create = found.is_none();
    let id = found.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let t = now();
    let mut cols = Map::new();
    cols.insert("signature".into(), json!(sig));
    cols.insert("name".into(), json!(name.trim()));
    cols.insert("map_json".into(), json!(text(&map_json)));
    cols.insert("archived".into(), json!(0));
    cols.insert("updated_at".into(), json!(t));
    if create {
        cols.insert("created_at".into(), json!(t));
    }
    write(&conn, MAPS, &id, cols, create)?;
    conn.query_row(&format!("SELECT {MAP_COLS} FROM {MAPS} WHERE id=?1"), [&id], map_row).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
//  Send to the Warehouse
// ---------------------------------------------------------------------------------------

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64()).filter(|x| x.is_finite())
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

/// One `LoadLine` per product. Product `retail` and `cost` are the product's totals (the sheet's
/// extended figures), so a unit is the total over the quantity. A sheet with no sizes gets one size
/// row named "Each", because the delivery's counting skips a blank size name.
fn load_lines(file: &str, products: &[Value], lines: &[Value]) -> Vec<LoadLine> {
    let place = |row: usize| -> String {
        let l = lines.iter().find(|l| l.get("row").and_then(|r| r.as_u64()) == Some(row as u64));
        match l {
            Some(l) => {
                let section = s(l, "section");
                if section.is_empty() { s(l, "page") } else { section }
            }
            None => String::new(),
        }
    };
    products
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let qty = num(p, "qty").unwrap_or(0.0).max(0.0).round() as i64;
            let per = |total: Option<f64>| -> f64 {
                match total {
                    Some(t) if qty > 0 => ((t / qty as f64) * 100.0).round() / 100.0,
                    Some(t) => (t * 100.0).round() / 100.0,
                    None => 0.0,
                }
            };
            let rows: Vec<usize> = p.get("rows").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as usize).collect()).unwrap_or_default();
            let first = rows.first().copied();
            let cost_total = num(p, "cost").or_else(|| num(p, "sheet_price"));
            let code = s(p, "code");
            let key = s(p, "key");
            let title = s(p, "title");
            let style = if !code.is_empty() { code } else if !key.is_empty() { key } else { format!("Item {}", i + 1) };
            LoadLine {
                id: format!("p{}", i + 1),
                brand: s(p, "brand"),
                description: title,
                style,
                cost: per(cost_total),
                msrp: per(num(p, "retail")),
                sizes: vec![SizeQty { size: "Each".into(), qty }],
                sheet_total: qty,
                source: match first {
                    Some(r) => format!("{file} row {r}"),
                    None => file.to_string(),
                },
                sheet: first.map(place).unwrap_or_default(),
                rows,
                ..Default::default()
            }
        })
        .collect()
}

/// Returns `{ id, name }` of the delivery. Make a Warehouse delivery from a saved manifest: one line per product. The delivery is linked on
/// the manifest. When `buy_id` is given (a buy on the way) the delivery is attached to it with
/// `attach_warehouse_buy`, which takes the count from the delivery. A manifest makes one delivery.
#[tauri::command]
pub async fn manifest_to_load(manifest_id: String, buy_id: Option<String>) -> Result<Value, String> {
    let (name, source, file_ref, products, lines) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let m = get(&conn, &manifest_id)?;
        if let Some(lid) = m["load_id"].as_str().filter(|l| !l.is_empty()) {
            let live: bool = conn
                .query_row("SELECT COALESCE(archived,0)=0 FROM warehouse_loads WHERE id=?1", [lid], |r| r.get(0))
                .unwrap_or(false);
            if live {
                return Err("This manifest already made a delivery.".into());
            }
        }
        (
            m["name"].as_str().unwrap_or("").to_string(),
            m["source_name"].as_str().unwrap_or("").to_string(),
            m["file_ref"].as_str().unwrap_or("").to_string(),
            m["products"].as_array().cloned().unwrap_or_default(),
            m["lines"].as_array().cloned().unwrap_or_default(),
        )
    };
    if products.is_empty() {
        return Err("This manifest has no products to send.".into());
    }
    let file = if source.is_empty() { name.clone() } else { source.clone() };
    let lines = load_lines(&file, &products, &lines);
    let kept = if file_ref.is_empty() { None } else { Some(crate::db::app_data_dir().join("sync").join(&file_ref)) };
    let id = match kept.filter(|p| p.is_file()) {
        Some(path) => {
            let v = crate::warehouse_loads::create_load_with_pictures(name, source, lines, path.to_string_lossy().to_string()).await?;
            v["load"]["id"].as_str().unwrap_or("").to_string()
        }
        None => crate::warehouse_loads::create_warehouse_load(name, source, lines, None, None).await?.load.id,
    };
    if id.is_empty() {
        return Err("The delivery was made but could not be found again.".into());
    }
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        set_links(&conn, &manifest_id, None, Some(id.clone()))?;
    }
    if let Some(b) = buy_id.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        crate::warehouse_buys::attach_warehouse_buy(b.to_string(), None, Some(id.clone()))
            .await
            .map_err(|e| format!("The delivery was made, but it could not join the buy: {e}"))?;
    }
    let d = crate::warehouse_loads::get_warehouse_load(id).await?;
    Ok(json!({ "id": d.load.id, "name": d.load.name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str) -> ManifestRecord {
        ManifestRecord {
            name: Some(name.into()),
            supplier: Some("Acme".into()),
            source_name: Some("acme.csv".into()),
            ask: Some(1200.0),
            totals: Some(json!({ "units": 30, "retail": 900.0 })),
            lines: Some(json!([
                { "row": 5, "desc": "Blue mug", "qty": 10, "retail": 100.0, "page": "Pallet 1", "section": "" },
                { "row": 6, "desc": "Red kettle", "qty": 20, "retail": 800.0, "page": "Pallet 2", "section": "Lot B" }
            ])),
            products: Some(json!([
                { "key": "012345", "title": "Blue mug", "code": "012345", "brand": "Acme", "qty": 10, "retail": 100.0, "cost": 40.0, "rows": [5], "lines": 1 },
                { "key": "red kettle", "title": "Red kettle", "code": "", "brand": "", "qty": 20, "retail": 800.0, "cost": null, "rows": [6], "lines": 1 }
            ])),
            ..Default::default()
        }
    }

    /// Saved, listed light, read back whole, renamed, deleted (archived) and restored, never destroyed.
    #[tokio::test]
    async fn a_manifest_saves_lists_deletes_and_comes_back() {
        let _db = crate::db::init_test_store();
        let src = std::env::temp_dir().join(format!("r564-{}.csv", uuid::Uuid::new_v4()));
        std::fs::write(&src, "Description,Qty\nBlue mug,10\n").unwrap();
        let mut rec = record("Acme pallets");
        rec.path = Some(src.to_string_lossy().to_string());
        let saved = save_manifest(rec).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        let file_ref = saved["file_ref"].as_str().unwrap().to_string();
        assert_eq!(file_ref, format!("media/manifests/{id}/{}", src.file_name().unwrap().to_string_lossy()));
        assert!(crate::db::app_data_dir().join("sync").join(&file_ref).is_file(), "the file is kept");
        assert_eq!((saved["product_count"].as_i64(), saved["line_count"].as_i64()), (Some(2), Some(2)));
        assert!(std::path::Path::new(saved["file_path"].as_str().unwrap()).is_file(), "file_path is the kept file");

        let listed = list_manifests().await.unwrap();
        let row = listed.iter().find(|m| m["id"] == id.as_str()).expect("listed");
        assert!(row.get("lines").is_none() && row.get("products").is_none(), "a list row is light");
        assert_eq!(row["totals"]["units"].as_i64(), Some(30));

        let full = get_manifest(id.clone()).await.unwrap();
        assert_eq!(full["products"].as_array().unwrap().len(), 2);
        assert_eq!(full["ask"].as_f64(), Some(1200.0));

        // A re-save of the same file does not clobber it.
        let mut again = ManifestRecord::default();
        again.id = Some(id.clone());
        again.path = Some(crate::db::app_data_dir().join("sync").join(&file_ref).to_string_lossy().to_string());
        save_manifest(again).await.unwrap();
        assert!(std::fs::metadata(crate::db::app_data_dir().join("sync").join(&file_ref)).unwrap().len() > 0);

        assert_eq!(update_manifest(id.clone(), Some("  Acme June ".into()), Some(900.0), None).await.unwrap()["name"], "Acme June");
        assert!(update_manifest(id.clone(), Some("  ".into()), None, None).await.is_err());

        delete_manifest(id.clone()).await.unwrap();
        assert!(!list_manifests().await.unwrap().iter().any(|m| m["id"] == id.as_str()));
        assert!(list_manifests_deleted().await.unwrap().iter().any(|m| m["id"] == id.as_str()));
        assert!(get_manifest(id.clone()).await.is_ok(), "archived, not destroyed");
        restore_manifest(id.clone()).await.unwrap();
        assert!(list_manifests().await.unwrap().iter().any(|m| m["id"] == id.as_str()));

        let linked = set_manifest_links(id.clone(), Some("lot-1".into()), None).await.unwrap();
        assert_eq!((linked["lot_id"].as_str(), linked["load_id"].as_str()), (Some("lot-1"), Some("")));
        let _ = std::fs::remove_file(&src);
    }

    #[tokio::test]
    async fn rules_save_once_and_delete_by_archive() {
        let _db = crate::db::init_test_store();
        let word = |p: &str, c: &str| ManifestRule { kind: "word".into(), pattern: p.into(), category: Some(c.into()), ..Default::default() };
        let all = save_manifest_rules(vec![word("Tonies r564", "Toys"), word("loafer r564", "Shoes")]).await.unwrap();
        assert_eq!(all.iter().filter(|r| r["pattern"].as_str().unwrap_or("").ends_with("r564")).count(), 2);
        // The same word again changes the rule, it does not double it.
        let all = save_manifest_rules(vec![word("TONIES R564", "Games")]).await.unwrap();
        let tonies: Vec<&Value> = all.iter().filter(|r| r["pattern"].as_str().unwrap_or("").to_lowercase() == "tonies r564").collect();
        assert_eq!((tonies.len(), tonies[0]["category"].as_str()), (1, Some("Games")));
        assert!(save_manifest_rules(vec![ManifestRule { kind: "nope".into(), pattern: "x".into(), category: Some("Toys".into()), ..Default::default() }]).await.is_err());
        assert!(save_manifest_rules(vec![ManifestRule { kind: "word".into(), pattern: "x".into(), ..Default::default() }]).await.is_err());
        let id = tonies[0]["id"].as_str().unwrap().to_string();
        let after = delete_manifest_rule(id.clone()).await.unwrap();
        assert!(!after.iter().any(|r| r["id"] == id.as_str()));
        assert!(list_manifest_rules().await.unwrap().iter().any(|r| r["pattern"] == "loafer r564"));
    }

    #[tokio::test]
    async fn a_column_map_is_found_by_its_header_and_changed_in_place() {
        let _db = crate::db::init_test_store();
        let sig = "description|qty|unit retail|r564";
        assert!(find_column_map(sig.into()).await.unwrap().is_none());
        let a = save_column_map(sig.into(), "Acme".into(), json!({ "header_row": 1, "roles": { "description": 0, "quantity": 1 } })).await.unwrap();
        let found = find_column_map(sig.into()).await.unwrap().expect("found");
        assert_eq!((found["id"].as_str(), found["name"].as_str(), found["map"]["roles"]["quantity"].as_i64()), (a["id"].as_str(), Some("Acme"), Some(1)));
        let b = save_column_map(sig.into(), "Acme 2".into(), json!({ "roles": { "description": 2 } })).await.unwrap();
        assert_eq!(b["id"], a["id"], "one map per header");
        assert_eq!(find_column_map(sig.into()).await.unwrap().unwrap()["map"]["roles"]["description"].as_i64(), Some(2));
        assert!(find_column_map("  ".into()).await.unwrap().is_none());
    }

    /// One delivery line per product, a unit from the product's totals, "Each" as the size, the page or
    /// section as the tab, and a second send refused while the first delivery is live.
    #[tokio::test]
    async fn a_manifest_becomes_one_delivery_line_per_product() {
        let _db = crate::db::init_test_store();
        let saved = save_manifest(record("Acme to warehouse")).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        let made = manifest_to_load(id.clone(), None).await.unwrap();
        assert_eq!(made["name"].as_str(), Some("Acme to warehouse"));
        let d = crate::warehouse_loads::get_warehouse_load(made["id"].as_str().unwrap().to_string()).await.unwrap();
        let lines = d.load.lines.as_ref().expect("lines");
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].style.as_str(), lines[0].brand.as_str(), lines[0].description.as_str()), ("012345", "Acme", "Blue mug"));
        assert_eq!((lines[0].cost, lines[0].msrp, lines[0].expected()), (4.0, 10.0, 10));
        assert_eq!((lines[0].sizes[0].size.as_str(), lines[0].sheet.as_str(), lines[0].source.as_str()), ("Each", "Pallet 1", "acme.csv row 5"));
        assert_eq!((lines[1].cost, lines[1].msrp, lines[1].sheet.as_str()), (0.0, 40.0, "Lot B"));
        assert_eq!(d.tally.totals.expected, 30);
        let m = get_manifest(id.clone()).await.unwrap();
        assert_eq!(m["load_id"].as_str(), Some(d.load.id.as_str()));
        assert_eq!(manifest_to_load(id, None).await.unwrap_err(), "This manifest already made a delivery.");
    }

    /// A manifest too big to sync in one event is saved in full here, and its sync event carries "[]".
    #[tokio::test]
    async fn an_oversized_lines_array_stays_local_and_syncs_empty() {
        let _db = crate::db::init_test_store();
        let big: Vec<Value> = (0..40_000).map(|i| json!({ "row": i, "desc": "x".repeat(200), "qty": 1, "retail": 1.0 })).collect();
        let mut rec = record("Huge r564");
        rec.lines = Some(Value::Array(big));
        assert!(text(rec.lines.as_ref().unwrap()).len() > MAX_SYNC_LINES);
        let saved = save_manifest(rec).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        assert_eq!(saved["line_count"].as_i64(), Some(40_000), "the local row keeps every line");
        assert_eq!(get_manifest(id.clone()).await.unwrap()["lines"].as_array().unwrap().len(), 40_000);
        assert_eq!(saved["product_count"].as_i64(), Some(2), "a part under its cap is not touched");

        fn find<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
            match v {
                Value::Object(m) => m.get(key).or_else(|| m.values().find_map(|x| find(x, key))),
                Value::Array(a) => a.iter().find_map(|x| find(x, key)),
                _ => None,
            }
        }
        let events: Vec<String> = {
            let conn = pool().get().unwrap();
            let mut stmt = conn.prepare("SELECT event_json FROM netsync_outbound").unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.filter_map(|r| r.ok()).collect()
        };
        let mine: Vec<Value> = events.iter().filter(|e| e.contains(&id)).filter_map(|e| serde_json::from_str(e).ok()).collect();
        assert!(!mine.is_empty(), "the save was queued for sync");
        let ev = mine.iter().find(|e| find(e, "lines_json").is_some()).expect("an event with lines_json");
        assert_eq!(find(ev, "lines_json").and_then(|v| v.as_str()), Some("[]"));
        assert!(find(ev, "products_json").and_then(|v| v.as_str()).map_or(false, |p| p.len() > 2), "products went whole");
    }
}
