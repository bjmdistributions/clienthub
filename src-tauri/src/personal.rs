//! R-660: personal spending. Jack (2026-11-16): "a section in finacials for personal spedning. i can choose the
//! account that is personal and it will break down and track where money goes ... completely sseparate from all
//! business stuff ... only linked the the exact user email".
//!
//! `personal_accounts` holds the accounts the workspace owner marked personal, `personal_txns` their transactions.
//! Neither is business money: nothing that totals, lists or checks the books reads them, and a personal account's
//! transactions never enter `bank_txn` (`plaid_sync` routes them here) and its balance leaves every business
//! balance. Every row id is the owner's key, a dot, then the rest; the server (clienthub-api routes/personal.rs)
//! hands these rows to the owner only and refuses them from anyone else, and only the owner can mark an account
//! (the server says who that is, `GET /api/personal/me`).
//!
//! A transaction's personal id is the owner's key, a dot, and the id the same row has in `bank_txn` (`btpl_` and the
//! Plaid id, or the moved row's own id), so Make personal and its undo move a row without changing what it is.
use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::db::pool;
use crate::sync;

/// One account the owner marked personal.
pub struct Mark {
    pub id: String,
    pub key: String,
    pub account_key: String,
    pub label: String,
}

/// The marks on this device. Only the owner's devices hold any (the server sends them to no one else).
pub fn marks(conn: &rusqlite::Connection) -> Vec<Mark> {
    conn.prepare("SELECT id, COALESCE(account_key,''), COALESCE(label,'') FROM personal_accounts ORDER BY label")
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
                .map(|it| it.filter_map(|x| x.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(id, account_key, label)| {
            let key = id.split_once('.').map(|(k, _)| k.to_string()).filter(|k| !k.is_empty())?;
            Some(Mark { id, key, account_key, label })
        })
        .collect()
}

/// The account keys (`bank_feed::account_key`: the bank and the last four) that are personal on this device.
pub fn account_keys(conn: &rusqlite::Connection) -> HashSet<String> {
    marks(conn).into_iter().map(|m| m.account_key).collect()
}

/// Whether a bank account (an entry of a Plaid item's account list) is personal. Every business balance, check and
/// list skips one that is.
pub fn is_personal(personal: &HashSet<String>, institution: &str, account: &Value) -> bool {
    !personal.is_empty() && personal.contains(&crate::bank_feed::account_key(institution, account))
}

/// Write a row locally and through the oplog, so the owner's other devices and phone get it.
fn write(conn: &rusqlite::Connection, table: &str, id: &str, cols: &Map<String, Value>) -> Result<(), String> {
    let names: Vec<&String> = cols.keys().collect();
    let sql = format!(
        "INSERT INTO {table} (id, {}) VALUES (?1, {}) ON CONFLICT(id) DO UPDATE SET {}",
        names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", "),
        (0..names.len()).map(|i| format!("?{}", i + 2)).collect::<Vec<_>>().join(", "),
        names.iter().map(|n| format!("{n}=excluded.{n}")).collect::<Vec<_>>().join(", "),
    );
    let mut params: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(id.to_string())];
    for n in &names {
        params.push(match &cols[n.as_str()] {
            Value::Null => rusqlite::types::Value::Null,
            Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
            Value::Number(x) if x.is_i64() => rusqlite::types::Value::Integer(x.as_i64().unwrap_or(0)),
            Value::Number(x) => rusqlite::types::Value::Real(x.as_f64().unwrap_or(0.0)),
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            other => rusqlite::types::Value::Text(other.to_string()),
        });
    }
    conn.execute(&sql, rusqlite::params_from_iter(params)).map_err(|e| e.to_string())?;
    sync::record_upsert(table, id, cols.clone()).map_err(|e| e.to_string())?;
    Ok(())
}

/// A transaction the bank sent for a personal account, stored as personal (added or changed). Same fields the
/// business import reads: the bank memo as the description, Plaid's merchant, its spending category.
/// True when the row is new (R-663: only a new one is worth a notice).
pub fn upsert_from_plaid(conn: &rusqlite::Connection, key: &str, account_key: &str, label: &str, t: &Value, now: &str) -> Result<bool, String> {
    let tid = t.get("transaction_id").and_then(|v| v.as_str()).unwrap_or("");
    if tid.is_empty() { return Err("no transaction id".into()); }
    let id = format!("{key}.{}", crate::commands::plaid_txn_id(tid));
    let amt = t.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let merchant = t.get("merchant_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let pfc = t.get("personal_finance_category");
    // R-663: a category the owner chose stays; the bank's later word on the same transaction does not undo it.
    let chosen: Option<String> = conn
        .query_row("SELECT COALESCE(category,''), COALESCE(raw_json,'') FROM personal_txns WHERE id=?1", [&id],
                   |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok()
        .filter(|(_, raw)| owner_sorted(raw))
        .map(|(c, _)| c);
    let mut raw = json!({
        "pa": t.get("account_id").and_then(|v| v.as_str()).unwrap_or(""),
        "tid": tid,
        "dt": t.get("datetime").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            .or_else(|| t.get("authorized_datetime").and_then(|v| v.as_str())).unwrap_or(""),
        "pnd": t.get("pending").and_then(|v| v.as_bool()).unwrap_or(false),
        "pfcd": pfc.and_then(|c| c.get("detailed")).and_then(|v| v.as_str()).unwrap_or(""),
    });
    let mut cols = Map::new();
    cols.insert("account_key".into(), json!(account_key));
    cols.insert("account_label".into(), json!(label));
    cols.insert("posted_at".into(), json!(t.get("date").and_then(|v| v.as_str()).unwrap_or("")));
    cols.insert("amount".into(), json!((amt.abs() * 100.0).round() / 100.0));
    cols.insert("direction".into(), json!(if amt > 0.0 { "out" } else { "in" }));
    cols.insert("description".into(), json!(if name.is_empty() { merchant.clone() } else { name }));
    cols.insert("merchant".into(), json!(merchant));
    match &chosen {
        Some(c) => { cols.insert("category".into(), json!(c)); raw["uc"] = json!(true); }
        None => { cols.insert("category".into(), json!(pfc.and_then(|c| c.get("primary")).and_then(|v| v.as_str()).unwrap_or(""))); }
    }
    cols.insert("pending".into(), json!(t.get("pending").and_then(|v| v.as_bool()).unwrap_or(false) as i64));
    cols.insert("raw_json".into(), json!(raw.to_string()));
    cols.insert("updated_at".into(), json!(now));
    let new = conn.query_row("SELECT 1 FROM personal_txns WHERE id=?1", [&id], |_| Ok(())).is_err();
    if new { cols.insert("created_at".into(), json!(now)); }
    write(conn, "personal_txns", &id, &cols).map(|_| new)
}

/// R-663: whether the owner chose this row's category (`raw_json.uc`).
fn owner_sorted(raw_json: &str) -> bool {
    serde_json::from_str::<Value>(raw_json).ok().and_then(|v| v.get("uc").and_then(|x| x.as_bool())).unwrap_or(false)
}

/// R-663 (Jack: "I want it to have it own booking spot in personal"): the owner sorts a personal transaction into
/// a spending group. Kept on the row and marked as the owner's choice, so the bank's category never replaces it.
#[tauri::command]
pub async fn personal_set_category(id: String, category: String) -> Result<(), String> {
    let key = owner_key_from_server().await?;
    if !id.starts_with(&format!("{key}.")) { return Err("That is not one of your personal transactions.".into()); }
    let category = category.trim().to_uppercase();
    if category.is_empty() || !category.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
        return Err("Pick a category.".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let raw: String = conn.query_row("SELECT COALESCE(raw_json,'') FROM personal_txns WHERE id=?1", [&id], |r| r.get(0))
        .map_err(|_| "That transaction is no longer here.".to_string())?;
    let mut v: Value = serde_json::from_str(&raw).ok().filter(|v: &Value| v.is_object()).unwrap_or_else(|| json!({}));
    v["uc"] = json!(true);
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("UPDATE personal_txns SET category=?1, raw_json=?2, updated_at=?3 WHERE id=?4",
                 rusqlite::params![category, v.to_string(), now, id]).map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("category".into(), json!(category));
    cols.insert("raw_json".into(), json!(v.to_string()));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("personal_txns", &id, cols).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

/// R-663 (Jack: "Have a switch for notifications in personal so we are not flooded"): whether this computer says
/// when new personal transactions arrive. Off unless turned on; kept on this computer only.
fn notify_on(conn: &rusqlite::Connection) -> bool {
    conn.query_row("SELECT value FROM settings WHERE key='personal_notify'", [], |r| r.get::<_, String>(0))
        .map(|v| v == "1").unwrap_or(false)
}

#[tauri::command]
pub async fn personal_notify_get() -> Result<bool, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(notify_on(&conn))
}

#[tauri::command]
pub async fn personal_notify_set(on: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('personal_notify',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 [if on { "1" } else { "0" }]).map_err(|e| e.to_string())?;
    Ok(())
}

/// After a bank check: say how many new personal transactions came in, only with the switch on.
pub fn announce_new(conn: &rusqlite::Connection, count: i64) {
    if count > 0 && notify_on(conn) { crate::bills::emit_event("personal-new", json!({ "count": count })); }
}

/// The bank withdrew a transaction: remove its personal row, if it is one. True when a row went.
pub fn remove_from_plaid(conn: &rusqlite::Connection, keys: &HashSet<String>, tid: &str) -> bool {
    let bank_id = crate::commands::plaid_txn_id(tid);
    let mut gone = false;
    for k in keys {
        let id = format!("{k}.{bank_id}");
        if conn.query_row("SELECT 1 FROM personal_txns WHERE id=?1", [&id], |_| Ok(())).is_err() { continue; }
        if sync::record_delete("personal_txns", &id).is_ok() {
            gone |= conn.execute("DELETE FROM personal_txns WHERE id=?1", [&id]).unwrap_or(0) > 0;
        }
    }
    gone
}

/// Each personal account's balance, from the bank's account list a pull just read. Written only when it moved.
pub fn refresh_balances(conn: &rusqlite::Connection, institution: &str, accounts: &[Value], now: &str) {
    let marks = marks(conn);
    if marks.is_empty() { return; }
    for a in accounts {
        let key = crate::bank_feed::account_key(institution, a);
        let Some(m) = marks.iter().find(|m| m.account_key == key) else { continue };
        let b = a.get("balances");
        let cur = b.and_then(|b| b.get("current")).and_then(|v| v.as_f64());
        let avail = b.and_then(|b| b.get("available")).and_then(|v| v.as_f64());
        let limit = b.and_then(|b| b.get("limit")).and_then(|v| v.as_f64());
        let same: bool = conn.query_row(
            "SELECT balance IS ?2 AND available IS ?3 AND credit_limit IS ?4 FROM personal_accounts WHERE id=?1",
            rusqlite::params![m.id, cur, avail, limit], |r| r.get(0)).unwrap_or(false);
        if same { continue; }
        let mut cols = Map::new();
        cols.insert("balance".into(), json!(cur));
        cols.insert("available".into(), json!(avail));
        cols.insert("credit_limit".into(), json!(limit));
        cols.insert("balance_at".into(), json!(now));
        cols.insert("updated_at".into(), json!(now));
        let _ = write(conn, "personal_accounts", &m.id, &cols);
    }
}

/// The server's answer on whether this sign-in is the workspace owner, and the owner's key. None: not the owner, or
/// no answer (offline), so nothing personal may be marked or undone.
async fn owner_key_from_server() -> Result<String, String> {
    let (status, me) = crate::netsync::server_request("GET", "/api/personal/me", None).await
        .map_err(|_| "Ecliptr could not reach the server to check who you are. Try again when you are online.".to_string())?;
    if status == 404 {
        return Err("The server does not have personal spending yet. It arrives with the next server update.".into());
    }
    match (me.get("owner").and_then(|v| v.as_bool()), me.get("key").and_then(|v| v.as_str())) {
        (Some(true), Some(k)) if !k.is_empty() => Ok(k.to_string()),
        _ => Err("Personal spending is only for the workspace owner.".into()),
    }
}

/// Bring this device up to date before moving rows, as Clean up duplicates does: a booking made on another computer
/// that has not reached this one would look untied here.
async fn up_to_date() -> Result<(), String> {
    if !crate::netsync::is_enabled() { return Ok(()); }
    let synced = async {
        crate::netsync::push_pending().await?;
        crate::netsync::pull_apply().await
    }.await;
    synced.map(|_| ()).map_err(|e| format!("Nothing was moved: Ecliptr could not sync with the server first ({e}). Try again once sync works."))
}

/// Whether this sign-in has a Personal section. Asks the server; offline, a device that already holds personal
/// rows is the owner's (the server sends them to no one else).
#[tauri::command]
pub async fn personal_me() -> Result<Value, String> {
    match owner_key_from_server().await {
        Ok(_) => Ok(json!({ "owner": true })),
        Err(e) => {
            let held = pool().get().ok().map(|c| !marks(&c).is_empty()).unwrap_or(false);
            Ok(json!({ "owner": held, "reason": e }))
        }
    }
}

/// The Personal section: the marked accounts with their balances, the last 400 days of their transactions (newest
/// first), and the accounts that could be marked (connected on this computer, or on the books), each with its key.
#[tauri::command]
pub async fn personal_overview() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let accounts: Vec<Value> = conn.prepare(
        "SELECT account_key, COALESCE(label,''), COALESCE(institution,''), COALESCE(type,''), balance, available, credit_limit, \
                COALESCE(balance_at,'') FROM personal_accounts ORDER BY label")
        .and_then(|mut st| st.query_map([], |r| Ok(json!({
            "account_key": r.get::<_, String>(0)?, "label": r.get::<_, String>(1)?, "institution": r.get::<_, String>(2)?,
            "type": r.get::<_, String>(3)?, "balance": r.get::<_, Option<f64>>(4)?, "available": r.get::<_, Option<f64>>(5)?,
            "credit_limit": r.get::<_, Option<f64>>(6)?, "balance_at": r.get::<_, String>(7)?,
        }))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    let txns: Vec<Value> = conn.prepare(
        "SELECT id, account_key, COALESCE(account_label,''), COALESCE(posted_at,''), amount, COALESCE(direction,''), \
                COALESCE(description,''), COALESCE(merchant,''), COALESCE(category,''), COALESCE(pending,0) \
           FROM personal_txns WHERE posted_at >= date('now','-400 days') ORDER BY posted_at DESC, id")
        .and_then(|mut st| st.query_map([], |r| Ok(json!({
            "id": r.get::<_, String>(0)?, "account_key": r.get::<_, String>(1)?, "account": r.get::<_, String>(2)?,
            "posted_at": r.get::<_, String>(3)?, "amount": r.get::<_, f64>(4)?, "direction": r.get::<_, String>(5)?,
            "description": r.get::<_, String>(6)?, "merchant": r.get::<_, String>(7)?, "category": r.get::<_, String>(8)?,
            "pending": r.get::<_, i64>(9)? != 0,
        }))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    let marked = account_keys(&conn);
    // Accounts that could be marked: every account a bank connected on this computer sends, then any other account
    // name on the books (a statement import), each once.
    let mut seen: HashSet<String> = HashSet::new();
    let mut candidates: Vec<Value> = Vec::new();
    let items: Vec<(String, String)> = conn.prepare("SELECT COALESCE(institution,''), accounts_json FROM plaid_items ORDER BY created_at")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    for (inst, aj) in items {
        for a in serde_json::from_str::<Vec<Value>>(&aj).unwrap_or_default() {
            let key = crate::bank_feed::account_key(&inst, &a);
            if marked.contains(&key) || !seen.insert(key.clone()) { continue; }
            let label = crate::commands::plaid_account_label(&a);
            seen.insert(format!("label|{}", label.to_lowercase()));
            candidates.push(json!({
                "account_key": key, "label": label, "institution": inst,
                "type": a.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                "balance": a.get("balances").and_then(|b| b.get("current")).and_then(|v| v.as_f64()),
                "rows": business_rows(&conn, &label),
            }));
        }
    }
    let labels: Vec<(String, i64)> = conn.prepare("SELECT account_id, COUNT(*) FROM bank_txn WHERE COALESCE(account_id,'')<>'' GROUP BY account_id ORDER BY account_id")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    for (label, rows) in labels {
        let key = format!("label|{}", label.to_lowercase());
        if marked.contains(&key) || !seen.insert(key.clone()) { continue; }
        candidates.push(json!({ "account_key": key, "label": label, "institution": "", "type": "", "balance": Value::Null, "rows": rows }));
    }
    Ok(json!({ "accounts": accounts, "txns": txns, "candidates": candidates }))
}

/// How many business rows an account name holds.
fn business_rows(conn: &rusqlite::Connection, label: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM bank_txn WHERE account_id=?1", [label], |r| r.get(0)).unwrap_or(0)
}

/// Make an account personal (Jack: the personal card imported by mistake). From now on the bank's transactions for
/// it go to Personal, and the rows already on the books under its name move there: each is backed up in full first
/// (`bank_txn_deleted_backup`, reason `moved_to_personal`; no backup, no move), written as a personal row keeping
/// that backup, then removed from the books through the oplog. A row tied to a deal, refund, loan, purchase,
/// expense or bill stays in the business books and is listed: moving it would orphan that work.
#[tauri::command]
pub async fn personal_mark(account_key: String, label: String, institution: String, kind: String) -> Result<Value, String> {
    let key = owner_key_from_server().await?;
    if account_key.trim().is_empty() || label.trim().is_empty() { return Err("Pick an account first.".into()); }
    up_to_date().await?;
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mark_id = format!("{key}.{account_key}");
    let mut cols = Map::new();
    cols.insert("account_key".into(), json!(account_key));
    cols.insert("label".into(), json!(label));
    cols.insert("institution".into(), json!(institution));
    cols.insert("type".into(), json!(kind));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    write(&conn, "personal_accounts", &mark_id, &cols)?;
    // Its balance now, not at the next pull.
    if !institution.is_empty() {
        let lists: Vec<String> = conn.prepare("SELECT accounts_json FROM plaid_items WHERE COALESCE(institution,'')=?1")
            .and_then(|mut st| st.query_map([&institution], |r| r.get(0)).map(|it| it.filter_map(|x| x.ok()).collect()))
            .unwrap_or_default();
        for aj in lists { refresh_balances(&conn, &institution, &serde_json::from_str::<Vec<Value>>(&aj).unwrap_or_default(), &now); }
    }
    let mark = Mark { id: mark_id, key, account_key, label };
    let (moved, not_moved, kept) = move_account_rows(&conn, &mark, &crate::commands::account_alias_map(), &now);
    crate::netsync::push_now();
    Ok(json!({ "moved": moved, "not_moved": not_moved, "kept": kept }))
}

/// Every name a personal account's rows can sit under on the books (R-666). Make personal used to look for the
/// account's name exactly as the bank gives it today, so rows filed under the name it was merged into (a confirmed
/// alias), under the name the bank used before it renamed the account, or under a bare Plaid account id stayed on
/// the books and in To book. The names: the one it was marked under; the name and the Plaid id of every connected
/// account with the same bank and last four; and every name the alias map folds together with one of those.
/// Never a guess from the last four alone: another bank's card can end in the same digits.
pub fn labels_of(conn: &rusqlite::Connection, mark: &Mark, aliases: &std::collections::HashMap<String, String>) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    if !mark.label.trim().is_empty() { out.insert(mark.label.clone()); }
    let items: Vec<(String, String)> = conn.prepare("SELECT COALESCE(institution,''), COALESCE(accounts_json,'[]') FROM plaid_items")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    for (inst, aj) in items {
        for a in serde_json::from_str::<Vec<Value>>(&aj).unwrap_or_default() {
            if crate::bank_feed::account_key(&inst, &a) != mark.account_key { continue; }
            let label = crate::commands::plaid_account_label(&a);
            if !label.trim().is_empty() { out.insert(label); }
            if let Some(id) = a.get("account_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) { out.insert(id.to_string()); }
        }
    }
    let via = |l: &str| aliases.get(l).cloned().unwrap_or_else(|| l.to_string());
    let folded: HashSet<String> = out.iter().map(|l| via(l)).collect();
    for (from, to) in aliases {
        if folded.contains(to) || folded.contains(&via(from)) { out.insert(from.clone()); }
    }
    out.extend(folded);
    out
}

/// Move a personal account's rows off the books: (moved, not moved, the rows that stay because they are tied to
/// business work). Each row is backed up in full first (`bank_txn_deleted_backup`, reason `moved_to_personal`; no
/// backup, no move), written as a personal row keeping that backup, then removed from the books through the oplog.
/// A row tied to a deal, refund, loan, purchase, expense or bill stays: moving it would orphan that work.
fn move_account_rows(conn: &rusqlite::Connection, mark: &Mark, aliases: &std::collections::HashMap<String, String>, now: &str) -> (i64, i64, Vec<Value>) {
    let (key, account_key, label) = (&mark.key, &mark.account_key, &mark.label);
    let (mut moved, mut not_moved) = (0i64, 0i64);
    let mut kept: Vec<Value> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for name in labels_of(conn, mark, aliases) {
        let found: Vec<String> = conn.prepare("SELECT id FROM bank_txn WHERE account_id=?1 ORDER BY posted_at")
            .and_then(|mut st| st.query_map([&name], |r| r.get(0)).map(|it| it.filter_map(|x| x.ok()).collect()))
            .unwrap_or_default();
        ids.extend(found);
    }
    for bid in &ids {
        if crate::commands::bank_txn_is_linked(conn, bid) {
            kept.push(conn.query_row(
                "SELECT json_object('id',id,'posted_at',posted_at,'amount',amount,'direction',direction,'description',description) FROM bank_txn WHERE id=?1",
                [bid], |r| r.get::<_, String>(0)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({ "id": bid })));
            continue;
        }
        let Ok(backup) = conn.query_row(crate::commands::BANK_TXN_BACKUP_SQL, [bid], |r| r.get::<_, String>(0)) else { not_moved += 1; continue };
        if conn.execute(
            "INSERT OR REPLACE INTO bank_txn_deleted_backup (id,row_json,survivor_id,reason,deleted_at) VALUES (?1,?2,?3,'moved_to_personal',?4)",
            rusqlite::params![bid, backup, format!("{key}.{bid}"), now]).is_err() { not_moved += 1; continue; }
        let b: Value = serde_json::from_str(&backup).unwrap_or(json!({}));
        let s = |k: &str| b.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let raw: Value = serde_json::from_str(&s("raw_json")).unwrap_or(json!({}));
        let mut c = Map::new();
        c.insert("account_key".into(), json!(account_key));
        c.insert("account_label".into(), json!(label));
        c.insert("posted_at".into(), json!(s("posted_at")));
        c.insert("amount".into(), b.get("amount").cloned().unwrap_or(json!(0)));
        c.insert("direction".into(), json!(s("direction")));
        c.insert("description".into(), json!(s("description")));
        c.insert("merchant".into(), json!(raw.get("merchant").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| s("counterparty_name"))));
        c.insert("category".into(), json!(category_from_business(&s("category"), &s("direction"))));
        c.insert("pending".into(), json!(raw.get("pnd").and_then(|v| v.as_bool()).unwrap_or(false) as i64));
        // The whole business row, so Stop treating as personal can put it back exactly.
        c.insert("raw_json".into(), json!(json!({ "moved_from": b }).to_string()));
        c.insert("created_at".into(), json!(now));
        c.insert("updated_at".into(), json!(now));
        if write(conn, "personal_txns", &format!("{key}.{bid}"), &c).is_err() { not_moved += 1; continue; }
        // Oplog first: a row deleted here but not recorded would come back on the next pull.
        if sync::record_delete("bank_txn", bid).is_err() { not_moved += 1; continue; }
        if conn.execute("DELETE FROM bank_txn WHERE id=?1", [bid]).unwrap_or(0) > 0 { moved += 1; }
    }
    (moved, not_moved, kept)
}

/// R-666 (Jack, 2026-11-17: "the personal transactions are still showing up in the too book"). A personal
/// account's transactions can still reach the books from outside this computer: another computer that feeds the
/// same bank holds no marks (the server sends them to the owner's devices only), and an older version knows nothing
/// of Personal. So the owner's computer takes them back off: after every sync that brought rows in and after every
/// check of the banks, any row on the books under a personal account's names moves to Personal, the same backed-up
/// move Make personal does. Nothing happens on a device with no marks. Returns how many rows moved.
pub fn sweep(conn: &rusqlite::Connection) -> i64 {
    let marks = marks(conn);
    if marks.is_empty() { return 0; }
    let aliases = crate::commands::account_alias_map();
    let now = chrono::Utc::now().to_rfc3339();
    let moved: i64 = marks.iter().map(|m| move_account_rows(conn, m, &aliases, &now).0).sum();
    if moved > 0 {
        tracing::info!("personal: {moved} row(s) of a personal account taken off the books");
        crate::netsync::push_now();
    }
    moved
}

/// Undo Make personal: the account's transactions go back to the business books, unbooked unless they were booked
/// before they moved (a moved row comes back exactly as it was), and the bank's transactions for it go to the books
/// again from the next pull.
#[tauri::command]
pub async fn personal_unmark(account_key: String) -> Result<Value, String> {
    let key = owner_key_from_server().await?;
    up_to_date().await?;
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    let prefix = format!("{key}.");
    let rows: Vec<(String, String, String, String, f64, String, String, String, String, String)> = conn.prepare(
        "SELECT id, COALESCE(account_label,''), COALESCE(posted_at,''), COALESCE(direction,''), amount, COALESCE(description,''), \
                COALESCE(merchant,''), COALESCE(category,''), COALESCE(raw_json,''), COALESCE(created_at,'') \
           FROM personal_txns WHERE account_key=?1 AND substr(id,1,length(?2))=?2")
        .and_then(|mut st| st.query_map(rusqlite::params![account_key, prefix], |r| Ok((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
        ))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .map_err(|e| e.to_string())?;
    let mut back = 0i64;
    for (pid, label, posted, dir, amount, desc, merchant, pcat, raw, _) in &rows {
        let bid = pid[prefix.len()..].to_string();
        let raw: Value = serde_json::from_str(raw).unwrap_or(json!({}));
        let mut c = Map::new();
        if let Some(b) = raw.get("moved_from").and_then(|v| v.as_object()) {
            for (k, v) in b {
                if k == "id" || k == "allocations" || k == "org_id" || v.is_null() { continue; }
                c.insert(k.clone(), v.clone());
            }
        } else {
            c.insert("account_id".into(), json!(label));
            c.insert("posted_at".into(), json!(posted));
            c.insert("amount".into(), json!(amount));
            c.insert("direction".into(), json!(dir));
            c.insert("description".into(), json!(desc));
            c.insert("memo_raw".into(), json!(desc));
            c.insert("category".into(), json!(crate::commands::plaid_category(pcat, dir)));
            c.insert("counterparty_name".into(), json!(if merchant.is_empty() { desc } else { merchant }));
            c.insert("source_format".into(), json!("plaid"));
            c.insert("reviewed".into(), json!(0));
            let mut r = raw.as_object().cloned().unwrap_or_default();
            r.remove("pfcd");
            if !merchant.is_empty() { r.insert("merchant".into(), json!(merchant)); }
            c.insert("raw_json".into(), json!(Value::Object(r).to_string()));
            c.insert("imported_at".into(), json!(now));
            c.insert("created_at".into(), json!(now));
        }
        c.insert("updated_at".into(), json!(now));
        // A row already back on the books (another computer undid it first) is left as it is.
        if conn.query_row("SELECT 1 FROM bank_txn WHERE id=?1", [&bid], |_| Ok(())).is_ok() {
            let _ = sync::record_delete("personal_txns", pid).map(|_| conn.execute("DELETE FROM personal_txns WHERE id=?1", [pid]));
            continue;
        }
        if write(&conn, "bank_txn", &bid, &c).is_err() { continue; }
        if sync::record_delete("personal_txns", pid).is_ok() {
            let _ = conn.execute("DELETE FROM personal_txns WHERE id=?1", [pid]);
            back += 1;
        }
    }
    let mark_id = format!("{key}.{account_key}");
    if sync::record_delete("personal_accounts", &mark_id).is_ok() {
        let _ = conn.execute("DELETE FROM personal_accounts WHERE id=?1", [&mark_id]);
    }
    crate::netsync::push_now();
    Ok(json!({ "back": back }))
}

/// A business category in the words Plaid uses for spending, so a moved row lands in the same Personal group as one
/// the bank sent.
fn category_from_business(cat: &str, direction: &str) -> &'static str {
    match cat {
        "meals" => "FOOD_AND_DRINK",
        "merchandise" | "inventory" | "cogs" => "GENERAL_MERCHANDISE",
        "auto" | "fuel" | "shipping" => "TRANSPORTATION",
        "travel" => "TRAVEL",
        "utilities" | "rent" => "RENT_AND_UTILITIES",
        "professional" | "software" | "subscriptions" => "GENERAL_SERVICES",
        "fee" => "BANK_FEES",
        "taxes" => "GOVERNMENT_AND_NON_PROFIT",
        "internal_transfer" => if direction == "in" { "TRANSFER_IN" } else { "TRANSFER_OUT" },
        "card_payment" => "LOAN_PAYMENTS",
        "receipt" => "INCOME",
        _ => if direction == "in" { "INCOME" } else { "OTHER" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // R-660: a transaction the bank sends for a personal account is stored as personal and nowhere in the books.
    #[test]
    fn a_personal_accounts_transaction_lands_in_personal() {
        let _db = crate::db::init_test_store();
        let c = pool().get().unwrap();
        let t = json!({ "transaction_id": "r660Abc", "account_id": "acc1", "amount": 12.5, "date": "2026-11-12",
                        "name": "TEST STORE 123", "merchant_name": "Test Store", "pending": false,
                        "personal_finance_category": { "primary": "GENERAL_MERCHANDISE", "detailed": "GENERAL_MERCHANDISE_OTHER" } });
        upsert_from_plaid(&c, "k660", "test bank|9999", "Card ··9999", &t, "2026-11-12T10:00:00Z").unwrap();
        let (dir, amt, cat, merchant): (String, f64, String, String) = c.query_row(
            "SELECT direction, amount, category, merchant FROM personal_txns WHERE id='k660.btpl_r660Abc'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!((dir.as_str(), amt, cat.as_str(), merchant.as_str()), ("out", 12.5, "GENERAL_MERCHANDISE", "Test Store"));
        assert!(c.query_row("SELECT 1 FROM bank_txn WHERE id='btpl_r660Abc'", [], |_| Ok(())).is_err(), "never in the books");
        let keys: HashSet<String> = ["k660".to_string()].into();
        assert!(remove_from_plaid(&c, &keys, "r660Abc"), "the bank withdrew it");
        assert!(!remove_from_plaid(&c, &keys, "r660Abc"));
    }

    // R-660: the marks give the owner key and the personal accounts.
    #[test]
    fn marks_carry_the_owner_key() {
        let _db = crate::db::init_test_store();
        let c = pool().get().unwrap();
        c.execute("INSERT INTO personal_accounts (id, account_key, label) VALUES ('k660.test bank|9999','test bank|9999','Card ··9999')", []).unwrap();
        let m = marks(&c);
        assert_eq!((m[0].key.as_str(), m[0].account_key.as_str()), ("k660", "test bank|9999"));
        assert!(account_keys(&c).contains("test bank|9999"));
        // A balance from the bank's list lands on the mark.
        let accts = vec![json!({ "account_id": "acc1", "name": "Card", "mask": "9999", "balances": { "current": 431.2, "available": null, "limit": 2000.0 } })];
        refresh_balances(&c, "Test Bank", &accts, "2026-11-12T10:00:00Z");
        let (bal, lim): (f64, f64) = c.query_row("SELECT balance, credit_limit FROM personal_accounts WHERE id='k660.test bank|9999'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((bal, lim), (431.2, 2000.0));
        c.execute("DELETE FROM personal_accounts WHERE id LIKE 'k660.%'", []).unwrap();
        c.execute("DELETE FROM personal_txns WHERE id LIKE 'k660.%'", []).unwrap();
    }

    // R-666: rows of a personal account leave the books whatever name they were filed under, and a row another
    // computer imports afterwards is taken off by the sweep. A booked row and another bank's card stay.
    #[test]
    fn a_personal_accounts_rows_leave_the_books_under_every_name() {
        let _db = crate::db::init_test_store();
        let c = pool().get().unwrap();
        let clean = |c: &rusqlite::Connection| {
            c.execute("DELETE FROM bank_txn WHERE id LIKE 'r666_%'", []).unwrap();
            c.execute("DELETE FROM personal_txns WHERE id LIKE 'k666.%'", []).unwrap();
            c.execute("DELETE FROM personal_accounts WHERE id LIKE 'k666.%'", []).unwrap();
            c.execute("DELETE FROM plaid_items WHERE id='pi_r666'", []).unwrap();
            c.execute("DELETE FROM bank_allocation WHERE bank_txn_id LIKE 'r666_%'", []).unwrap();
        };
        clean(&c);
        c.execute("INSERT INTO plaid_items (id, access_token, cursor, accounts_json, env, institution, created_at) \
                   VALUES ('pi_r666','x','','[{\"account_id\":\"accR666\",\"name\":\"Everyday Card\",\"mask\":\"6660\"}]','sandbox','Test Bank','2026-11-01')", []).unwrap();
        c.execute("INSERT INTO personal_accounts (id, account_key, label) VALUES ('k666.test bank|6660','test bank|6660','Old Card Name \u{00b7}\u{00b7}6660')", []).unwrap();
        let row = |id: &str, acct: &str| {
            c.execute("INSERT INTO bank_txn (id, account_id, posted_at, amount, direction, description, category, reviewed, source_format, imported_at, created_at, updated_at) \
                       VALUES (?1, ?2, '2026-11-10', 20.0, 'out', 'TEST SHOP', 'other', 0, 'plaid', '2026-11-10', '2026-11-10', '2026-11-10')",
                rusqlite::params![id, acct]).unwrap();
        };
        row("r666_marked", "Old Card Name \u{00b7}\u{00b7}6660");   // the name it was marked under
        row("r666_today", "Everyday Card \u{00b7}\u{00b7}6660");    // the name the bank gives it today
        row("r666_bare", "accR666");                                   // a bare Plaid account id
        row("r666_alias", "My Card");                                  // the name it was merged into
        row("r666_other", "Other Bank Card \u{00b7}\u{00b7}6660");  // another bank's card with the same last four
        let aliases: std::collections::HashMap<String, String> = [("Everyday Card \u{00b7}\u{00b7}6660".to_string(), "My Card".to_string())].into();
        let m = marks(&c).into_iter().find(|m| m.key == "k666").unwrap();
        let (moved, not_moved, kept) = move_account_rows(&c, &m, &aliases, "2026-11-17T10:00:00Z");
        assert_eq!((moved, not_moved, kept.len()), (4, 0, 0));
        let on_books = |id: &str| c.query_row("SELECT 1 FROM bank_txn WHERE id=?1", [id], |_| Ok(())).is_ok();
        assert!(!on_books("r666_marked") && !on_books("r666_today") && !on_books("r666_bare") && !on_books("r666_alias"));
        assert!(on_books("r666_other"), "the last four alone is never enough");
        let personal: i64 = c.query_row("SELECT COUNT(*) FROM personal_txns WHERE id LIKE 'k666.r666_%'", [], |r| r.get(0)).unwrap();
        let backed: i64 = c.query_row("SELECT COUNT(*) FROM bank_txn_deleted_backup WHERE id LIKE 'r666_%' AND reason='moved_to_personal'", [], |r| r.get(0)).unwrap();
        assert_eq!((personal, backed), (4, 4), "each moved row is a personal row and has its backup");
        // Another computer puts a new row on the books: the sweep takes it off.
        row("r666_late", "Everyday Card \u{00b7}\u{00b7}6660");
        assert!(sweep(&c) >= 1);
        assert!(!on_books("r666_late") && on_books("r666_other"));
        assert_eq!(sweep(&c), 0, "nothing left to move");
        c.execute("DELETE FROM bank_txn_deleted_backup WHERE id LIKE 'r666_%'", []).unwrap();
        clean(&c);
    }

    #[test]
    fn a_business_category_maps_to_a_spending_group() {
        assert_eq!(category_from_business("meals", "out"), "FOOD_AND_DRINK");
        assert_eq!(category_from_business("internal_transfer", "in"), "TRANSFER_IN");
        assert_eq!(category_from_business("", "in"), "INCOME");
        assert_eq!(category_from_business("whatever", "out"), "OTHER");
    }
}
