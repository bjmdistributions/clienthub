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
// Generic default for a freshly-seeded local org_default row — never a personal /
// company name. The real workspace name comes from the signed-in account / server
// (materialized on login and via sync). Jack's existing org_default row already
// stores his real name and is NOT changed (the seed is INSERT OR IGNORE).
const ORG_NAME: &str = "";
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
        "ALTER TABLE staff_accounts ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'profit_pct'",
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
    pub avatar: String,
    pub title: String,
    pub phone: String,
}

fn load_me(staff_id: &str) -> Option<Me> {
    let conn = pool().get().ok()?;
    let (id, email, name, role_id, status, role_name, perms_json, avatar, title, phone): (String, String, String, String, String, String, String, String, String, String) =
        conn.query_row(
            "SELECT s.id, s.email, s.display_name, s.role_id, s.status, r.name, r.permissions_json,
                    COALESCE(s.avatar,''), COALESCE(s.title,''), COALESCE(s.phone,'')
             FROM staff_accounts s JOIN roles r ON r.id = s.role_id WHERE s.id=?1",
            [staff_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        ).ok()?;
    if status != "active" { return None; }
    let permissions: Vec<String> = serde_json::from_str(&perms_json).unwrap_or_default();
    let is_admin = permissions.iter().any(|p| p == "*" || p == "admin:manage");
    Some(Me { id, email, display_name: name, role_id, role_name, permissions, is_admin, avatar, title, phone })
}

/// Self-service: the signed-in employee updates their own profile.
#[tauri::command]
pub fn update_my_account(display_name: Option<String>, title: Option<String>, phone: Option<String>, avatar: Option<String>) -> Result<Me, String> {
    let id = current_staff_id().ok_or("Not signed in")?;
    let me = load_me(&id).ok_or("Not signed in")?;
    let dn = display_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or(me.display_name);
    let title = title.unwrap_or(me.title);
    let phone = phone.unwrap_or(me.phone);
    let avatar = avatar.unwrap_or(me.avatar);
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE staff_accounts SET display_name=?1, title=?2, phone=?3, avatar=?4, updated_at=?5 WHERE id=?6",
            rusqlite::params![dn, title, phone, avatar, now, id],
        ).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("display_name".into(), Value::String(dn));
    cols.insert("title".into(), Value::String(title));
    cols.insert("phone".into(), Value::String(phone));
    cols.insert("avatar".into(), Value::String(avatar));
    cols.insert("updated_at".into(), Value::String(now));
    sync_upsert("staff_accounts", &id, cols);
    load_me(&id).ok_or_else(|| "reload failed".to_string())
}

/// The signed-in employee's display name (for note authorship etc.), or "".
pub fn current_display_name() -> String {
    current_staff_id()
        .and_then(|id| load_me(&id))
        .map(|m| m.display_name)
        .unwrap_or_default()
}

fn current_staff_id() -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key='current_staff_id'", [], |r| r.get::<_, String>(0)).ok()
}

/// The org id for a staff account in the active store (for per-account store
/// isolation). Desktop is single-org, so this is normally `org_default`.
fn staff_org_id(staff_id: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT org_id FROM staff_accounts WHERE id=?1", [staff_id], |r| r.get::<_, String>(0)).ok()
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

// ── Last-admin guardrails ───────────────────────────────────────────────────
// "Admin" is defined by permissions (`*` or `admin:manage`), matching the
// server, so a custom role granted full access still counts as an admin.
const ADMIN_PRED: &str =
    "(r.permissions_json LIKE '%\"*\"%' OR r.permissions_json LIKE '%admin:manage%')";

fn role_grants_admin(conn: &rusqlite::Connection, role_id: &str) -> bool {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM roles r WHERE r.id=?1 AND {ADMIN_PRED}"),
        [role_id], |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0
}

fn user_grants_admin(conn: &rusqlite::Connection, user_id: &str) -> bool {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM staff_accounts s JOIN roles r ON r.id=s.role_id WHERE s.id=?1 AND {ADMIN_PRED}"),
        [user_id], |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0
}

fn other_active_admins(conn: &rusqlite::Connection, exclude_id: &str) -> i64 {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM staff_accounts s JOIN roles r ON r.id=s.role_id WHERE s.id<>?1 AND s.status='active' AND {ADMIN_PRED}"),
        [exclude_id], |r| r.get::<_, i64>(0),
    ).unwrap_or(0)
}

/// True when the current desktop user may act without approval: the owner (no
/// staff session = PIN) or an admin. Non-admin reps return false.
pub fn session_is_privileged() -> bool {
    match current_staff_id() {
        None => true,
        Some(id) => load_me(&id).map(|m| m.is_admin).unwrap_or(true),
    }
}

/// (id, display_name) of the signed-in staff member, if any (owner PIN → None).
pub fn session_actor() -> Option<(String, String)> {
    let id = current_staff_id()?;
    load_me(&id).map(|m| (m.id, m.display_name))
}

/// Whether a per-org approval toggle is on (stored "1"/"true").
pub fn approval_required(key: &str) -> bool {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return false };
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)
}

/// Persist a row to staff tables AND emit a sync event so it reaches the server.
fn sync_upsert(table: &str, row_id: &str, cols: Map<String, Value>) {
    let _ = sync::record_upsert(table, row_id, cols);
}

// ──────────────────────── Auth commands ────────────────────────

#[derive(Serialize)]
pub struct AuthStatus { pub has_accounts: bool, pub signed_in: bool }

fn admin_exists() -> bool {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return false };
    conn.query_row(
        "SELECT COUNT(*) FROM staff_accounts s JOIN roles r ON r.id=s.role_id
         WHERE s.status='active' AND (r.permissions_json LIKE '%\"*\"%' OR r.permissions_json LIKE '%admin:manage%')",
        [], |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0
}

#[tauri::command]
pub fn employee_status() -> Result<AuthStatus, String> {
    // `has_accounts` drives login vs bootstrap: we only require login once an
    // admin exists. Invited non-admin staff must not block owner setup.
    let signed_in = current_staff_id().and_then(|id| load_me(&id)).is_some();
    Ok(AuthStatus { has_accounts: admin_exists(), signed_in })
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
    if admin_exists() { return Err("An owner account already exists. Sign in instead.".into()); }
    // Block duplicate emails (case-insensitive).
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let dup: i64 = conn.query_row("SELECT COUNT(*) FROM staff_accounts WHERE lower(email)=?1", [&email], |r| r.get(0)).unwrap_or(0);
        if dup > 0 { return Err("That email is already in use. Sign in instead.".into()); }
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

/// Production server base URL for hosted auth + sync.
const SERVER_URL: &str = "https://ecliptr.app";

/// Unified sign-in for the SaaS world. Local-first so the existing/offline owner
/// always gets in instantly with no internet, and so a bad network never locks
/// anyone out: on a successful local login we just activate server-hub sync in
/// the background. Only when no local account matches do we authenticate against
/// the server and pull the org down — that's a website-created account signing in
/// on a fresh device. The server (not Syncthing) becomes the sync hub either way.
#[tauri::command]
pub async fn login(email: String, password: String) -> Result<Me, String> {
    // 1. Local-first: instant + offline-safe for accounts already on this device.
    //    An account is only local to the ACTIVE store, so a successful local login
    //    means this account already belongs here — safe to proceed + claim.
    if let Ok(me) = employee_login(email.clone(), password.clone()) {
        // This account is local to the active store → it owns/shares this store.
        if let Some(org) = staff_org_id(&me.id) {
            crate::db::claim_active_store_org(&org);
        }
        let (e, p) = (email.clone(), password.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(err) = crate::netsync::connect(SERVER_URL, &e, &p).await {
                tracing::warn!("netsync connect after local login: {}", err);
            }
        });
        return Ok(me);
    }

    // 2. No local match. Before pulling ANY data into the active store, probe the
    //    server to learn this account's org id. If it belongs to a DIFFERENT org
    //    than the one that owns the active store, we must NOT mix its data in —
    //    route it to its own per-account store and ask the app to restart there.
    let (_, identity) = match crate::netsync::probe_login(SERVER_URL, &email, &password).await {
        Ok(v) => v,
        Err(e) => {
            let msg = e.to_string();
            return if msg.contains("HTTP") {
                Err("Invalid email or password.".into())
            } else {
                Err("Couldn't reach the server, and no local account matches. Check your connection and try again.".into())
            };
        }
    };
    let org_id = identity.org_id.clone();

    if let Some(store_org) = crate::db::active_store_org() {
        if !org_id.is_empty() && org_id != store_org {
            // Different workspace than the one occupying this store → switch stores
            // and restart. The current store's data is left completely untouched.
            crate::db::set_active_store_for_org(&org_id).map_err(|e| e.to_string())?;
            return Err(format!("__SWITCH_WORKSPACE__:{}", org_id));
        }
    }

    // 3. Same org as this store (or store unclaimed) → connect, pull the org down,
    //    claim the store, then complete the login locally. Crucially, we MATERIALIZE
    //    the account (staff row + its role) from the authoritative server login body
    //    FIRST, so login never depends on the async pull restoring the RBAC rows
    //    (which is exactly the "Could not load account" failure on a fresh install).
    //    The pull still runs to restore all business data; this just guarantees the
    //    identity is present regardless of pull timing.
    match crate::netsync::connect(SERVER_URL, &email, &password).await {
        Ok(returned) => {
            let claim_org = if returned.org_id.is_empty() { &org_id } else { &returned.org_id };
            crate::db::claim_active_store_org(claim_org);
            // Additive materialization — never clears anything (data-safety).
            materialize_account(&returned, &password);
            employee_login(email, password)
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("HTTP") {
                Err("Invalid email or password.".into())
            } else {
                Err("Couldn't reach the server, and no local account matches. Check your connection and try again.".into())
            }
        }
    }
}

/// Write a server-authenticated account into the local store so `employee_login`
/// / `load_me` resolve immediately on a fresh install — independent of when (or
/// whether) the netsync pull restores the RBAC rows. Purely ADDITIVE and data-safe:
///
///   - `orgs` and `roles` use INSERT OR IGNORE (never overwrite an existing local
///     role's permissions or an org's name),
///   - `staff_accounts` upserts ONLY this account's identity columns (id keyed),
///     storing a fresh bcrypt hash of the just-verified password so future OFFLINE
///     logins work. No other row is touched; nothing is ever deleted.
///
/// The server login body doesn't carry the password hash (correctly), so we hash
/// the password the user just authenticated with.
fn materialize_account(ident: &crate::netsync::ServerIdentity, password: &str) {
    if ident.id.is_empty() || ident.email.is_empty() {
        return; // nothing authoritative to write; leave the store untouched
    }
    let conn = match pool().get() { Ok(c) => c, Err(_) => return };
    let now = now_rfc3339();

    // Org row (name unknown from the login body — use org_id as a placeholder;
    // the real org/company name arrives via pull / is read from the server).
    if !ident.org_id.is_empty() {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO orgs (id,name,created_at) VALUES (?1,?2,?3)",
            rusqlite::params![ident.org_id, ident.org_id, now],
        );
    }

    // Role row so load_me's staff⋈roles JOIN resolves. INSERT OR IGNORE keeps any
    // existing local role (e.g. a seeded default) exactly as-is.
    if !ident.role_id.is_empty() {
        let perms = serde_json::to_string(&ident.permissions).unwrap_or_else(|_| "[]".into());
        let role_name = if ident.role_name.is_empty() { "Member" } else { &ident.role_name };
        let _ = conn.execute(
            "INSERT OR IGNORE INTO roles (id,org_id,name,permissions_json,is_system,created_at) VALUES (?1,?2,?3,?4,1,?5)",
            rusqlite::params![ident.role_id, ident.org_id, role_name, perms, now],
        );
    }

    // The account itself. Hash the just-verified password for offline sign-in.
    let hash = match bcrypt::hash(password, bcrypt::DEFAULT_COST) {
        Ok(h) => h,
        Err(_) => return,
    };
    let _ = conn.execute(
        "INSERT INTO staff_accounts (id,org_id,email,password_hash,display_name,role_id,status,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,'active',?7,?7)
         ON CONFLICT(id) DO UPDATE SET org_id=excluded.org_id, email=excluded.email,
             password_hash=excluded.password_hash, display_name=excluded.display_name,
             role_id=excluded.role_id, status='active', updated_at=excluded.updated_at",
        rusqlite::params![ident.id, ident.org_id, ident.email.to_lowercase(), hash, ident.display_name, ident.role_id, now],
    );
    // Optional profile fields (best-effort; columns exist on the desktop schema).
    let _ = conn.execute(
        "UPDATE staff_accounts SET avatar=?1, title=?2, phone=?3 WHERE id=?4",
        rusqlite::params![ident.avatar, ident.title, ident.phone, ident.id],
    );
}

/// Restart the app so it re-opens against the store the pointer now targets. Used
/// after `login` signals `__SWITCH_WORKSPACE__` (the pointer is already written):
/// the front-end confirms the workspace switch, then calls this. On next launch
/// `db::init` opens the per-account (possibly empty) store and the account signs
/// in there. No data is moved or deleted.
#[tauri::command]
pub fn switch_workspace_restart(app: tauri::AppHandle) {
    app.restart();
}

/// Whether the active local store already belongs to a workspace, and which one.
/// Lets the UI reason about workspace switches. `store_org` is empty on a brand-new
/// store no account has claimed yet.
#[tauri::command]
pub fn active_workspace() -> Value {
    json!({
        "store_org": crate::db::active_store_org().unwrap_or_default(),
    })
}

// ──────────────────────── Team management (admin) ────────────────────────

#[tauri::command]
pub fn list_staff() -> Result<Vec<Value>, String> {
    require_admin()?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.email, s.display_name, s.role_id, r.name, s.status, s.commission_pct, s.hide_pay_cuts,
                COALESCE(s.avatar,''), COALESCE(s.title,''), COALESCE(s.phone,''), s.created_at, COALESCE(s.pay_type,'profit_pct')
         FROM staff_accounts s LEFT JOIN roles r ON r.id=s.role_id WHERE s.org_id=?1 ORDER BY s.created_at",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([ORG_ID], |r| Ok(json!({
        "id": r.get::<_,String>(0)?, "email": r.get::<_,String>(1)?, "display_name": r.get::<_,String>(2)?,
        "role_id": r.get::<_,String>(3)?, "role_name": r.get::<_,Option<String>>(4)?, "status": r.get::<_,String>(5)?,
        "commission_pct": r.get::<_,f64>(6)?, "hide_pay_cuts": r.get::<_,i64>(7)? != 0,
        "avatar": r.get::<_,String>(8)?, "title": r.get::<_,String>(9)?,
        "phone": r.get::<_,String>(10)?, "created_at": r.get::<_,Option<String>>(11)?,
        "pay_type": r.get::<_,String>(12)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn update_staff(id: String, role_id: Option<String>, status: Option<String>, commission_pct: Option<f64>, hide_pay_cuts: Option<bool>, pay_type: Option<String>) -> Result<(), String> {
    require_admin()?;
    let now = now_rfc3339();
    let mut cols = Map::new();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        if let Some(v) = &role_id {
            // Don't let the org demote its only admin into lockout.
            if user_grants_admin(&conn, &id) && !role_grants_admin(&conn, v) && other_active_admins(&conn, &id) == 0 {
                return Err("Can't demote the last admin — make someone else an admin first.".into());
            }
            conn.execute("UPDATE staff_accounts SET role_id=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("role_id".into(), json!(v));
        }
        if let Some(v) = &status {
            // Suspending the last active admin would lock the org out.
            if v == "suspended" && user_grants_admin(&conn, &id) && other_active_admins(&conn, &id) == 0 {
                return Err("Can't suspend the last admin — make someone else an admin first.".into());
            }
            conn.execute("UPDATE staff_accounts SET status=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("status".into(), json!(v));
        }
        if let Some(v) = commission_pct { conn.execute("UPDATE staff_accounts SET commission_pct=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("commission_pct".into(), json!(v)); }
        if let Some(v) = hide_pay_cuts { conn.execute("UPDATE staff_accounts SET hide_pay_cuts=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v as i64, now, id]).map_err(|e| e.to_string())?; cols.insert("hide_pay_cuts".into(), json!(v as i64)); }
        if let Some(v) = &pay_type { let v = match v.as_str() { "gross_pct" | "fixed" => v.as_str(), _ => "profit_pct" }; conn.execute("UPDATE staff_accounts SET pay_type=?1, updated_at=?2 WHERE id=?3", rusqlite::params![v, now, id]).map_err(|e| e.to_string())?; cols.insert("pay_type".into(), json!(v)); }
    }
    if !cols.is_empty() { cols.insert("updated_at".into(), json!(now)); sync_upsert("staff_accounts", &id, cols); }
    Ok(())
}

/// Admin: permanently remove a team member. Can't delete yourself or the last
/// admin. Unassigns them from deals and syncs the deletion to web + other devices.
#[tauri::command]
pub fn delete_staff(id: String) -> Result<(), String> {
    require_admin()?;
    if current_staff_id().as_deref() == Some(id.as_str()) {
        return Err("You can't delete your own account.".into());
    }
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let exists: i64 = conn.query_row("SELECT COUNT(*) FROM staff_accounts WHERE id=?1", [&id], |r| r.get(0)).unwrap_or(0);
        if exists == 0 { return Err("User not found.".into()); }
        // Don't let the org delete its last admin and lock itself out.
        if user_grants_admin(&conn, &id) && other_active_admins(&conn, &id) == 0 {
            return Err("Can't remove the last admin.".into());
        }
        conn.execute("DELETE FROM deal_reps WHERE lead_rep_id=?1", [&id]).ok();
        conn.execute("DELETE FROM staff_accounts WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    let _ = sync::record_delete("staff_accounts", &id);
    Ok(())
}

#[tauri::command]
pub fn list_roles() -> Result<Value, String> {
    require_admin()?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, permissions_json, is_system FROM roles WHERE org_id=?1 ORDER BY is_system DESC, name").map_err(|e| e.to_string())?;
    let roles: Vec<Value> = stmt.query_map([ORG_ID], |r| {
        let perms: Vec<String> = serde_json::from_str(&r.get::<_,String>(2)?).unwrap_or_default();
        Ok(json!({"id": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?, "permissions": perms, "is_system": r.get::<_,i64>(3)? != 0}))
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(json!({"roles": roles, "modules": MODULES}))
}

/// Granular per-role visibility flags that don't fit the module×action grid:
/// see exact client spend, see suppliers, see deal-flow dollar figures.
pub const EXTRA_PERMS: [&str; 3] =
    ["clients:view_revenue", "suppliers:view", "deal_flow:view_numbers"];

fn is_valid_perm(p: &str) -> bool {
    if p == "admin:manage" { return true; }
    if EXTRA_PERMS.contains(&p) { return true; }
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
        // Allow deleting any invite (used/expired/active), not just unused.
        conn.execute("DELETE FROM invites WHERE token=?1", [&token]).map_err(|e| e.to_string())?;
    }
    let _ = sync::record_delete("invites", &token);
    Ok(())
}

#[tauri::command]
pub fn reopen_invite(token: String) -> Result<Value, String> {
    require_admin()?;
    let new_exp = (chrono::Utc::now() + chrono::Duration::days(14)).to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let n = conn.execute(
            "UPDATE invites SET used_at=NULL, expires_at=?1 WHERE token=?2",
            rusqlite::params![new_exp, token],
        ).map_err(|e| e.to_string())?;
        if n == 0 { return Err("Invite not found".into()); }
    }
    // Sync the reopened state (cleared used_at + new expiry) to peers.
    let mut cols = Map::new();
    cols.insert("expires_at".into(), json!(new_exp));
    cols.insert("used_at".into(), Value::Null);
    sync_upsert("invites", &token, cols);
    Ok(json!({"token": token, "expires_at": new_exp}))
}
