//! Unified RBAC on the desktop — the same `staff_accounts` / `roles` / `invites`
//! / `deal_reps` model the server uses, synced via the HLC sync layer so identity
//! and team management are identical across desktop, web, and mobile.
//!
//! The desktop is local-first: login verifies a bcrypt hash against the synced
//! `staff_accounts` table (works offline) and persists `current_staff_id` in
//! settings. Owners manage the team here via Tauri commands that write the synced
//! tables, so changes appear on web/mobile (and vice-versa).

use crate::db::pool;
use crate::sync;
use serde::Serialize;
use serde_json::{json, Map, Value};

const ORG_ID: &str = "org_default";
const ORG_NAME: &str = "BJM Distributions";
pub const MODULES: [&str; 9] = [
    "clients", "inventory", "deal_flow", "quotes", "email", "manifests", "analytics", "settings", "admin",
];

fn now_rfc3339() -> String { chrono::Utc::now().to_rfc3339() }

fn seed_roles() -> Vec<(&'static str, &'static str, Vec<String>)> {
    let mut manager: Vec<String> = Vec::new();
    for m in MODULES {
        if m == "admin" || m == "settings" { continue; }
        for a in ["view", "edit", "export"] { manager.push(format!("{m}:{a}")); }
    }
    let sales: Vec<String> = ["clients", "inventory", "quotes", "email"]
        .iter()
        .flat_map(|m| [format!("{m}:view"), format!("{m}:edit")])
        .collect();
    let viewer: Vec<String> = MODULES.iter().filter(|m| **m != "admin").map(|m| format!("{m}:view")).collect();
    vec![
        ("role_admin", "Admin", vec!["*".to_string()]),
        ("role_manager", "Manager", manager),
        ("role_sales", "Sales", sales),
        ("role_viewer", "Viewer", viewer),
    ]
}

/// Create the synced RBAC tables locally and seed the org + system roles.
/// Mirrors the server's `employees::ensure_tables` so both sides converge.
pub fn ensure_rbac() -> anyhow::Result<()> {
    let conn = pool().get()?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
            permissions_json TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS staff_accounts (
            id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL,
            password_hash TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '',
            role_id TEXT NOT NULL DEFAULT 'role_viewer', status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
            commission_pct REAL NOT NULL DEFAULT 0, hide_pay_cuts INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS invites (
            token TEXT PRIMARY KEY, org_id TEXT NOT NULL, role_id TEXT NOT NULL, email TEXT,
            created_by TEXT, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deal_reps (
            deal_flow_id TEXT PRIMARY KEY, lead_rep_id TEXT, assigned_by TEXT, assigned_at TEXT
        );
        "#,
    )?;
    // Backfill pay columns on a staff_accounts mirror created by an older build.
    for stmt in [
        "ALTER TABLE staff_accounts ADD COLUMN commission_pct REAL NOT NULL DEFAULT 0",
        "ALTER TABLE staff_accounts ADD COLUMN hide_pay_cuts INTEGER NOT NULL DEFAULT 0",
    ] { let _ = conn.execute(stmt, []); }

    let now = now_rfc3339();
    conn.execute("INSERT OR IGNORE INTO orgs (id,name,created_at) VALUES (?1,?2,?3)",
        rusqlite::params![ORG_ID, ORG_NAME, now]).ok();
    for (id, name, perms) in seed_roles() {
        conn.execute(
            "INSERT OR IGNORE INTO roles (id,org_id,name,permissions_json,is_system,created_at) VALUES (?1,?2,?3,?4,1,?5)",
            rusqlite::params![id, ORG_ID, name, serde_json::to_string(&perms).unwrap(), now],
        ).ok();
    }
    Ok(())
}

// ──────────────────────── Session model ────────────────────────

#[derive(Serialize, Clone)]
pub struct Me {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub role_id: String,
    pub role_name: String,
    pub permissions: Vec<String>,
    pub is_admin: bool,
}

fn load_me(staff_id: &str) -> Option<Me> {
    let conn = pool().get().ok()?;
    let (id, email, name, role_id, status, role_name, perms_json): (String, String, String, String, String, String, String) =
        conn.query_row(
            "SELECT s.id, s.email, s.display_name, s.role_id, s.status, r.name, r.permissions_json
             FROM staff_accounts s JOIN roles r ON r.id = s.role_id WHERE s.id=?1",
            [staff_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        ).ok()?;
    if status != "active" { return None; }
    let permissions: Vec<String> = serde_json::from_str(&perms_json).unwrap_or_default();
    let is_admin = permissions.iter().any(|p| p == "*" || p == "admin:manage");
    Some(Me { id, email, display_name: name, role_id, role_name, permissions, is_admin })
}

fn current_staff_id() -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key='current_staff_id'", [], |r| r.get::<_, String>(0)).ok()
}

fn set_current_staff(id: Option<&str>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    match id {
        Some(v) => conn.execute(
            "INSERT INTO settings (key,value) VALUES ('current_staff_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [v]).map(|_| ()).map_err(|e| e.to_string()),
        None => conn.execute("DELETE FROM settings WHERE key='current_staff_id'", []).map(|_| ()).map_err(|e| e.to_string()),
    }
}

fn require_admin() -> Result<Me, String> {
    let id = current_staff_id().ok_or("Not signed in")?;
    let me = load_me(&id).ok_or("Not signed in")?;
    if !me.is_admin { return Err("You don't have permission for that".into()); }
    Ok(me)
}

/// Persist a row to staff tables AND emit a sync event so it reaches the server.
fn sync_upsert(table: &str, row_id: &str, cols: Map<String, Value>) {
    let _ = sync::record_upsert(table, row_id, cols);
}

// ──────────────────────── Auth commands ────────────────────────

#[derive(Serialize)]
pub struct AuthStatus { pub has_accounts: bool, pub signed_in: bool }

#[tauri::command]
pub fn employee_status() -> Result<AuthStatus, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM staff_accounts WHERE status='active'", [], |r| r.get(0)).unwrap_or(0);
    let signed_in = current_staff_id().and_then(|id| load_me(&id)).is_some();
    Ok(AuthStatus { has_accounts: count > 0, signed_in })
}

#[tauri::command]
pub fn employee_me() -> Result<Option<Me>, String> {
    Ok(current_staff_id().and_then(|id| load_me(&id)))
}

#[tauri::command]
pub fn employee_logout() -> Result<(), String> { set_current_staff(None) }

#[tauri::command]
pub fn employee_bootstrap(display_name: String, email: String, password: String) -> Result<Me, String> {
    if display_name.trim().is_empty() || password.len() < 8 {
        return Err("Enter your name and an 8+ character password.".into());
    }
    let email = email.trim().to_lowercase();
    if email.is_empty() { return Err("Enter an email.".into()); }
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let has: i64 = conn.query_row("SELECT COUNT(*) FROM staff_accounts", [], |r| r.get(0)).unwrap_or(0);
        if has > 0 { return Err("An owner account already exists. Sign in instead.".into()); }
    }
    let hash = bcrypt::hash(&password, bcrypt::DEFAULT_COST).map_err(|_| "Could not secure password")?;
    let id = format!("usr_{}", uuid::Uuid::new_v4().simple());
    let now = now_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO staff_accounts (id,org_id,email,password_hash,display_name,role_id,status,created_at,updated_at,commission_pct,hide_pay_cuts)
             VALUES (?1,?2,?3,?4,?5,'role_admin','active',?6,?6,0,0)",
            rusqlite::params![id, ORG_ID, email, hash, display_name.trim(), now],
        ).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!(ORG_ID));
    cols.insert("email".into(), json!(email));
    cols.insert("password_hash".into(), json!(hash));
    cols.insert("display_name".into(), json!(display_name.trim()));
    cols.insert("role_id".into(), json!("role_admin"));
    cols.insert("status".into(), json!("active"));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    sync_upsert("staff_accounts", &id, cols);
    set_current_staff(Some(&id))?;
    load_me(&id).ok_or_else(|| "Could not load account".into())
}

#[tauri::command]
pub fn employee_login(email: String, password: String) -> Result<Me, String> {
    let email = email.trim().to_lowercase();
    let row: Option<(String, String, String)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, password_hash, status FROM staff_accounts WHERE lower(email)=?1",
            [&email], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).ok()
    };
    let (id, hash, status) = row.ok_or("Invalid email or password.")?;
    if status != "active" { return Err("This account is suspended.".into()); }
    let ok = bcrypt::verify(&password, &hash).unwrap_or(false);
    if !ok { return Err("Invalid email or password.".into()); }
    set_current_staff(Some(&id))?;
    load_me(&id).ok_or_else(|| "Could not load account".into())
}

// ──────────────────────── Team management (admin) ────────────────────────

#[tauri::command]
pub fn list_staff() -> Result<Vec<Value>, String> {
    require_admin()?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.email, s.display_name, s.role_id, r.name, s.status, s.commission_pct, s.hide_pay_cuts
         FROM staff_accounts s LEFT JOIN roles r ON r.id=s.role_id ORDER BY s.created_at",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(json!({
        "id": r.get::<_,String>(0)?, "email": r.get::<_,String>(1)?, "display_name": r.get::<_,String>(2)?,
        "role_id": r.get::<_,String>(3)?, "role_name": r.get::<_,Option<String>>(4)?, "status": r.get::<_,String>(5)?,
        "commission_pct": r.get::<_,f64>(6)?, "hide_pay_cuts": r.get::<_,i64>(7)? != 0,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn update_staff(id: String, role_id: Option<String>, status: Option<String>, commission_pct: Option<f64>, hide_pay_cuts: Option<bool>) -> Result<(), String> {
    require_admin()?;
    let now = now_rfc3339();
    let mut cols = Map::new();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        if let Some(v) = &role_id { conn.execute("UPDATE staff_accounts SET role_id=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("role_id".into(), json!(v)); }
        if let Some(v) = &status { conn.execute("UPDATE staff_accounts SET status=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("status".into(), json!(v)); }
        if let Some(v) = commission_pct { conn.execute("UPDATE staff_accounts SET commission_pct=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("commission_pct".into(), json!(v)); }
        if let Some(v) = hide_pay_cuts { conn.execute("UPDATE staff_accounts SET hide_pay_cuts=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v as i64, now, id]).map_err(|e| e.to_string())?; cols.insert("hide_pay_cuts".into(), json!(v as i64)); }
    }
    if !cols.is_empty() { cols.insert("updated_at".into(), json!(now)); sync_upsert("staff_accounts", &id, cols); }
    Ok(())
}

#[tauri::command]
pub fn list_roles() -> Result<Value, String> {
    require_admin()?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, permissions_json, is_system FROM roles ORDER BY is_system DESC, name").map_err(|e| e.to_string())?;
    let roles: Vec<Value> = stmt.query_map([], |r| {
        let perms: Vec<String> = serde_json::from_str(&r.get::<_,String>(2)?).unwrap_or_default();
        Ok(json!({"id": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?, "permissions": perms, "is_system": r.get::<_,i64>(3)? != 0}))
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(json!({"roles": roles, "modules": MODULES}))
}

fn is_valid_perm(p: &str) -> bool {
    if p == "admin:manage" { return true; }
    match p.split_once(':') { Some((m, a)) => MODULES.contains(&m) && ["view","edit","export"].contains(&a), None => false }
}

#[tauri::command]
pub fn create_role(name: String) -> Result<Value, String> {
    require_admin()?;
    let name = name.trim();
    if name.is_empty() { return Err("Role name required".into()); }
    let id = format!("role_{}", uuid::Uuid::new_v4().simple());
    let now = now_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO roles (id,org_id,name,permissions_json,is_system,created_at) VALUES (?1,?2,?3,'[]',0,?4)",
            rusqlite::params![id, ORG_ID, name, now]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!(ORG_ID));
    cols.insert("name".into(), json!(name));
    cols.insert("permissions_json".into(), json!("[]"));
    cols.insert("is_system".into(), json!(0));
    cols.insert("created_at".into(), json!(now));
    sync_upsert("roles", &id, cols);
    Ok(json!({"id": id, "name": name, "permissions": [], "is_system": false}))
}

#[tauri::command]
pub fn update_role(id: String, permissions: Vec<String>) -> Result<(), String> {
    require_admin()?;
    if id == "role_admin" { return Err("The Admin role always has full access.".into()); }
    let clean: Vec<String> = permissions.into_iter().filter(|p| is_valid_perm(p)).collect();
    let json_str = serde_json::to_string(&clean).unwrap_or_else(|_| "[]".into());
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE roles SET permissions_json=?1 WHERE id=?2", rusqlite::params![json_str, id]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("permissions_json".into(), json!(json_str));
    sync_upsert("roles", &id, cols);
    Ok(())
}

#[tauri::command]
pub fn list_invites() -> Result<Vec<Value>, String> {
    require_admin()?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT i.token, i.role_id, r.name, i.email, i.expires_at, i.used_at, i.created_at
         FROM invites i LEFT JOIN roles r ON r.id=i.role_id ORDER BY i.created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(json!({
        "token": r.get::<_,String>(0)?, "role_id": r.get::<_,String>(1)?, "role_name": r.get::<_,Option<String>>(2)?,
        "email": r.get::<_,Option<String>>(3)?, "expires_at": r.get::<_,String>(4)?,
        "used_at": r.get::<_,Option<String>>(5)?, "created_at": r.get::<_,String>(6)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn create_invite(role_id: String, email: Option<String>, expires_days: Option<i64>) -> Result<Value, String> {
    let admin = require_admin()?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let exists: i64 = conn.query_row("SELECT COUNT(*) FROM roles WHERE id=?1", [&role_id], |r| r.get(0)).unwrap_or(0);
        if exists == 0 { return Err("Unknown role".into()); }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let days = expires_days.unwrap_or(7).clamp(1, 90);
    let expires = (chrono::Utc::now() + chrono::Duration::days(days)).to_rfc3339();
    let now = now_rfc3339();
    let email_l = email.map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty());
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO invites (token,org_id,role_id,email,created_by,expires_at,used_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,?7)",
            rusqlite::params![token, ORG_ID, role_id, email_l, admin.id, expires, now],
        ).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!(ORG_ID));
    cols.insert("role_id".into(), json!(role_id));
    cols.insert("email".into(), json!(email_l));
    cols.insert("created_by".into(), json!(admin.id));
    cols.insert("expires_at".into(), json!(expires));
    cols.insert("created_at".into(), json!(now));
    sync_upsert("invites", &token, cols);
    Ok(json!({"token": token, "signup_path": format!("/staff?invite={token}"), "expires_at": expires}))
}

#[tauri::command]
pub fn revoke_invite(token: String) -> Result<(), String> {
    require_admin()?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM invites WHERE token=?1 AND used_at IS NULL", [&token]).map_err(|e| e.to_string())?;
    }
    let _ = sync::record_delete("invites", &token);
    Ok(())
}
