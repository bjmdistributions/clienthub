//! Checkup sessions (desktop). Mirrors the server: a session snapshots clients
//! as items; reviewing one logs a `kind='checkup'` interaction on the client.
//! Local DB + sync; visibility (team/private) comes from the `checkup_visibility`
//! setting. Single-tenant desktop, so org is always `org_default`.

use crate::db::pool;
use crate::sync;
use serde_json::{json, Map, Value};

const ORG: &str = "org_default";

fn now() -> String { chrono::Utc::now().to_rfc3339() }

fn visibility() -> String {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return "team".into() };
    conn.query_row("SELECT value FROM settings WHERE key='checkup_visibility'", [], |r| r.get::<_, String>(0))
        .unwrap_or_else(|_| "team".into())
}

#[tauri::command]
pub fn create_checkup(name: Option<String>, category: Option<String>) -> Result<Value, String> {
    let nm = name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Checkup · {}", chrono::Utc::now().format("%b %-d")));
    let (owner_id, owner_name) = match crate::employees::session_actor() {
        Some((i, n)) => (Some(i), n),
        None => (None, "Owner".to_string()),
    };
    let sid = uuid::Uuid::new_v4().to_string();
    let ts = now();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO checkup_sessions (id,org_id,name,owner_id,owner_name,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'active',?6,?6)",
            rusqlite::params![sid, ORG, nm, owner_id, owner_name, ts],
        ).map_err(|e| e.to_string())?;
    }
    let mut sc = Map::new();
    sc.insert("org_id".into(), json!(ORG)); sc.insert("name".into(), json!(nm));
    sc.insert("owner_id".into(), json!(owner_id)); sc.insert("owner_name".into(), json!(owner_name));
    sc.insert("status".into(), json!("active")); sc.insert("created_at".into(), json!(ts)); sc.insert("updated_at".into(), json!(ts));
    sync::record_upsert("checkup_sessions", &sid, sc).map_err(|e| e.to_string())?;

    let client_ids: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let cat = category.as_ref().filter(|s| !s.is_empty());
        if let Some(cat) = cat {
            let mut stmt = conn.prepare("SELECT id FROM clients WHERE COALESCE(approval_status,'active')!='pending' AND LOWER(json_extract(metadata,'$.category'))=LOWER(?1) ORDER BY name").map_err(|e| e.to_string())?;
            let v: Vec<String> = stmt.query_map([cat], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
            v
        } else {
            let mut stmt = conn.prepare("SELECT id FROM clients WHERE COALESCE(approval_status,'active')!='pending' ORDER BY name").map_err(|e| e.to_string())?;
            let v: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
            v
        }
    };
    for cid in &client_ids {
        let iid = uuid::Uuid::new_v4().to_string();
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute("INSERT INTO checkup_items (id,org_id,session_id,client_id,reviewed,note,created_at) VALUES (?1,?2,?3,?4,0,'',?5)",
                rusqlite::params![iid, ORG, sid, cid, ts]).map_err(|e| e.to_string())?;
        }
        let mut ic = Map::new();
        ic.insert("org_id".into(), json!(ORG)); ic.insert("session_id".into(), json!(sid)); ic.insert("client_id".into(), json!(cid));
        ic.insert("reviewed".into(), json!(0)); ic.insert("note".into(), json!("")); ic.insert("created_at".into(), json!(ts));
        sync::record_upsert("checkup_items", &iid, ic).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "id": sid, "total": client_ids.len() }))
}

#[tauri::command]
pub fn list_checkups() -> Result<Vec<Value>, String> {
    let see_all = crate::employees::session_is_privileged() || visibility() == "team";
    let me = crate::employees::session_actor().map(|(i, _)| i).unwrap_or_default();
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT s.id, s.name, s.owner_name, s.status, s.created_at,
                (SELECT COUNT(*) FROM checkup_items WHERE session_id=s.id),
                (SELECT COUNT(*) FROM checkup_items WHERE session_id=s.id AND reviewed=1)
         FROM checkup_sessions s {} ORDER BY s.created_at DESC",
        if see_all { "" } else { "WHERE s.owner_id=?1" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| Ok(json!({
        "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "owner_name": r.get::<_, Option<String>>(2)?,
        "status": r.get::<_, String>(3)?, "created_at": r.get::<_, String>(4)?,
        "total": r.get::<_, i64>(5)?, "done": r.get::<_, i64>(6)?,
    }));
    let rows: Vec<Value> = if see_all {
        stmt.query_map([], map).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect()
    } else {
        stmt.query_map([me], map).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect()
    };
    Ok(rows)
}

#[tauri::command]
pub fn get_checkup(id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (name, status): (String, String) = conn.query_row(
        "SELECT name, status FROM checkup_sessions WHERE id=?1", [&id],
        |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| "not found".to_string())?;
    let mut stmt = conn.prepare(
        "SELECT i.id, i.client_id, c.name, c.phone, c.email, i.stage, i.note, i.reached_out_at
         FROM checkup_items i JOIN clients c ON c.id=i.client_id WHERE i.session_id=?1 ORDER BY i.stage, c.name",
    ).map_err(|e| e.to_string())?;
    let items: Vec<Value> = stmt.query_map([&id], |r| Ok(json!({
        "id": r.get::<_, String>(0)?, "client_id": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?,
        "phone": r.get::<_, Option<String>>(3)?, "email": r.get::<_, Option<String>>(4)?,
        "stage": r.get::<_, i64>(5)?, "note": r.get::<_, String>(6)?, "reached_out_at": r.get::<_, Option<String>>(7)?,
    }))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(json!({ "id": id, "name": name, "status": status, "items": items }))
}

/// Move an item between the 3 stages (0=to reach out, 1=reached out, 2=done) and
/// save its note. Stages 1 & 2 keep a single checkup interaction in sync (dated to
/// when first reached out); stage 0 removes it so Last activity reverts.
#[tauri::command]
pub fn set_checkup_item_stage(session_id: String, item_id: String, stage: i64, note: String) -> Result<(), String> {
    let stage = stage.clamp(0, 2);
    let ts = now();
    let (client_id, interaction_id, reached_out_at): (Option<String>, Option<String>, Option<String>) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT client_id, interaction_id, reached_out_at FROM checkup_items WHERE id=?1 AND session_id=?2",
            rusqlite::params![item_id, session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap_or((None, None, None))
    };
    let who = crate::employees::session_actor().map(|(_, n)| n).unwrap_or_default();
    let bodytext = if note.trim().is_empty() { "Reached out in checkup".to_string() } else { note.clone() };
    let new_reached: Option<String> = if stage >= 1 { Some(reached_out_at.clone().unwrap_or_else(|| ts.clone())) } else { None };

    let mut new_int_id = interaction_id.clone();
    if stage >= 1 {
        if let Some(cid) = client_id.clone() {
            if let Some(iid) = interaction_id.clone() {
                {
                    let conn = pool().get().map_err(|e| e.to_string())?;
                    conn.execute("UPDATE interactions SET body=?1 WHERE id=?2", rusqlite::params![bodytext, iid]).map_err(|e| e.to_string())?;
                }
                let mut nc = Map::new(); nc.insert("body".into(), json!(bodytext));
                sync::record_upsert("interactions", &iid, nc).map_err(|e| e.to_string())?;
            } else {
                let iid = uuid::Uuid::new_v4().to_string();
                let at = new_reached.clone().unwrap_or_else(|| ts.clone());
                {
                    let conn = pool().get().map_err(|e| e.to_string())?;
                    conn.execute("INSERT INTO interactions (id,client_id,kind,subject,body,created_at,user_name) VALUES (?1,?2,'checkup','Checkup',?3,?4,?5)",
                        rusqlite::params![iid, cid, bodytext, at, who]).map_err(|e| e.to_string())?;
                }
                let mut nc = Map::new();
                nc.insert("client_id".into(), json!(cid)); nc.insert("kind".into(), json!("checkup")); nc.insert("subject".into(), json!("Checkup"));
                nc.insert("body".into(), json!(bodytext)); nc.insert("created_at".into(), json!(at)); nc.insert("user_name".into(), json!(who));
                sync::record_upsert("interactions", &iid, nc).map_err(|e| e.to_string())?;
                new_int_id = Some(iid);
            }
        }
    } else if let Some(iid) = interaction_id.clone() {
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM interactions WHERE id=?1", [&iid]).map_err(|e| e.to_string())?;
        }
        sync::record_delete("interactions", &iid).map_err(|e| e.to_string())?;
        new_int_id = None;
    }

    let reviewed_at: Option<String> = if stage == 2 { Some(ts.clone()) } else { None };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE checkup_items SET stage=?1, reviewed=?2, note=?3, reached_out_at=?4, reviewed_at=?5, interaction_id=?6 WHERE id=?7",
            rusqlite::params![stage, (stage == 2) as i64, note, new_reached, reviewed_at, new_int_id, item_id]).map_err(|e| e.to_string())?;
        conn.execute("UPDATE checkup_sessions SET updated_at=?1 WHERE id=?2", rusqlite::params![ts, session_id]).map_err(|e| e.to_string())?;
    }
    let mut ic = Map::new();
    ic.insert("stage".into(), json!(stage)); ic.insert("reviewed".into(), json!((stage == 2) as i64)); ic.insert("note".into(), json!(note));
    ic.insert("reached_out_at".into(), json!(new_reached)); ic.insert("reviewed_at".into(), json!(reviewed_at)); ic.insert("interaction_id".into(), json!(new_int_id));
    sync::record_upsert("checkup_items", &item_id, ic).map_err(|e| e.to_string())?;
    let mut su = Map::new(); su.insert("updated_at".into(), json!(ts));
    sync::record_upsert("checkup_sessions", &session_id, su).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_checkup(id: String) -> Result<(), String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM checkup_items WHERE session_id=?1", [&id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM checkup_sessions WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    sync::record_delete("checkup_sessions", &id).map_err(|e| e.to_string())?;
    Ok(())
}
