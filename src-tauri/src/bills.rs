//! Bills on the desktop (R-449, R-445, R-446, R-447): the money that leaves on a schedule
//! (rent paid by Zelle, insurance, a car note), the payments the bank shows for them, and
//! where the rest of the money went.
//!
//! The rules (due dates, matching, links, state, detection, spending, true profit) are in
//! `bills_core.rs`, byte-identical on the server. This file is storage, sync and the Tauri
//! commands, all read from and written to the local SQLite:
//!
//!  * A bill is a row in `bills`, a payment link a row in `bill_payments`. Both are synced and
//!    authored by every device. A create sends every column, an update only the columns that
//!    changed (a logo is up to 40 KB and is never sent again unless it changed). A bill is
//!    archived, never deleted, and an unlinked payment is `rejected`, never deleted.
//!  * A bill never writes a `bank_allocation` row and never inserts a `bank_txn` row.
//!  * `run_auto_links` links what the bank just brought in. It runs after a converged
//!    `plaid_sync`, after a pull that applied bills events (`PullHook`), and for one bill after
//!    it is saved. A link id is made from the bill and the bank row, so two devices that link the
//!    same payment write one row, and a link Jack rejected is never written again.
//!  * R-454: the due date a link pays is worked out from all of the bill's payments
//!    (`bills_core::assign_periods`); the `period` stored on the link is only a copy. `heal_periods`
//!    writes the copies that are stale, after every save, hand link, unlink and restore and on every
//!    auto-link pass, so a payment stored under the wrong due date moves to the right one.
//!  * `bills_icon` and the two push preference commands go to the server (`netsync::server_request`).
//!
//! Every message returned as an `Err` is shown to Jack as it is, so each is a plain sentence.

use crate::bills_core as core;
use crate::commands::{DF_SURVIVOR_SQL, PNL_CATEGORY_GROUPS, PNL_TAX_PASSTHROUGH};
use crate::db::pool;
use crate::sync::{SyncEvent, SyncOp};
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// The app handle, so a change can tell the open screens (the sidebar badge, the Bills screen).
/// Set once at startup (`main.rs` setup). Tests and any path running before setup do not announce.
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn set_app(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// `bills-changed`: after any bills write and after an auto-link pass that wrote a link.
fn announce() {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit("bills-changed", ());
    }
}

const BUSY: &str = "Something went wrong with the bills. Try again in a moment.";

/// A database failure, logged, as the sentence Jack sees.
fn db<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| {
        tracing::warn!("bills: {e}");
        BUSY.to_string()
    })
}

const NOT_FOUND: &str = "That bill was not found.";

/// Pending at the bank (`$.pnd`) and retracted by the bank (`$.rtr`), read the way every other
/// bank query reads them: only behind `json_valid`, since a bare `json_extract` over an empty
/// `raw_json` throws.
const PENDING: &str = "COALESCE(CASE WHEN json_valid(t.raw_json) THEN json_extract(t.raw_json,'$.pnd') END,0)<>0";
const RETRACTED: &str = "CASE WHEN json_valid(t.raw_json) THEN json_extract(t.raw_json,'$.rtr') END IS NOT NULL";
/// What a row is worth after deal money is taken off it.
const REMAINDER: &str = "t.amount - COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=t.id),0)";
/// The non-rejected link a bank row has, if any.
const LIVE_LINK: &str = "(SELECT p2.id FROM bill_payments p2 WHERE p2.bank_txn_id=t.id AND p2.status<>'rejected' ORDER BY p2.created_at, p2.id LIMIT 1)";

fn day_string(d: NaiveDate) -> String {
    core::fmt_day(d)
}

fn since(today: NaiveDate, days: i64) -> String {
    day_string(today - Duration::days(days))
}

fn first_of_month(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1).unwrap_or(d)
}

fn last_of_month(d: NaiveDate) -> NaiveDate {
    core::occurrence(first_of_month(d), "monthly", 1) - Duration::days(1)
}

// ---------------------------------------------------------------------------- bills

#[derive(Debug, Clone)]
struct BillRow {
    id: String,
    name: String,
    payee_match: String,
    amount: f64,
    tolerance_pct: f64,
    cadence: String,
    anchor_date: String,
    category: String,
    method: String,
    website: String,
    logo: String,
    notes: String,
    status: String,
    created_at: String,
    updated_at: String,
}

impl BillRow {
    fn to_core(&self) -> core::Bill {
        core::Bill {
            id: self.id.clone(),
            name: self.name.clone(),
            payee_match: self.payee_match.clone(),
            amount: self.amount,
            tolerance_pct: self.tolerance_pct,
            cadence: self.cadence.clone(),
            anchor: self.anchor_date.clone(),
            status: self.status.clone(),
        }
    }
}

const BILL_SELECT: &str = "SELECT id, COALESCE(name,''), COALESCE(payee_match,''), COALESCE(amount,0), \
    COALESCE(tolerance_pct,10), COALESCE(cadence,'monthly'), COALESCE(anchor_date,''), COALESCE(category,''), \
    COALESCE(method,''), COALESCE(website,''), COALESCE(logo,''), COALESCE(notes,''), COALESCE(status,'active'), \
    COALESCE(created_at,''), COALESCE(updated_at,'') FROM bills";

fn map_bill(r: &rusqlite::Row) -> rusqlite::Result<BillRow> {
    Ok(BillRow {
        id: r.get(0)?,
        name: r.get(1)?,
        payee_match: r.get(2)?,
        amount: r.get(3)?,
        tolerance_pct: r.get(4)?,
        cadence: r.get(5)?,
        anchor_date: r.get(6)?,
        category: r.get(7)?,
        method: r.get(8)?,
        website: r.get(9)?,
        logo: r.get(10)?,
        notes: r.get(11)?,
        status: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
    })
}

/// Every bill row, including archived ones and dismissed suggestions (`ignored`).
fn load_bills(conn: &rusqlite::Connection) -> Result<Vec<BillRow>, String> {
    let mut stmt = db(conn.prepare(&format!("{BILL_SELECT} ORDER BY created_at, id")))?;
    let rows = db(stmt.query_map([], map_bill))?;
    db(rows.collect::<rusqlite::Result<Vec<_>>>())
}

/// One bill the screens can show (a dismissed suggestion is not one).
fn load_bill(conn: &rusqlite::Connection, id: &str) -> Result<BillRow, String> {
    let found = db(conn
        .query_row(&format!("{BILL_SELECT} WHERE id=?1 AND status<>'ignored'"), [id], map_bill)
        .optional())?;
    found.ok_or_else(|| NOT_FOUND.to_string())
}

// ------------------------------------------------------------------------ bank inputs

/// The org's money-out rows from `since` on, as `bills_core` reads them.
fn load_txns(conn: &rusqlite::Connection, since: &str) -> Result<Vec<core::Txn>, String> {
    let sql = format!(
        "SELECT t.id, substr(t.posted_at,1,10), t.amount, t.direction, COALESCE(t.counterparty_name,''), \
                COALESCE(t.description,''), COALESCE(t.category,''), COALESCE(t.counterparty_type,''), \
                {PENDING}, {RETRACTED}, \
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=t.id),0), \
                COALESCE((SELECT p.bill_id FROM bill_payments p WHERE p.bank_txn_id=t.id AND p.status<>'rejected' ORDER BY p.created_at, p.id LIMIT 1),'') \
         FROM bank_txn t WHERE t.direction='out' AND substr(t.posted_at,1,10) >= ?1 \
         ORDER BY t.posted_at, t.id"
    );
    let mut stmt = db(conn.prepare(&sql))?;
    let rows = db(stmt.query_map([since], |r| {
        Ok(core::Txn {
            id: r.get(0)?,
            posted_at: r.get(1)?,
            amount: r.get(2)?,
            direction: r.get(3)?,
            payee: r.get(4)?,
            memo: r.get(5)?,
            category: r.get(6)?,
            counterparty_type: r.get(7)?,
            pending: r.get::<_, i64>(8)? != 0,
            retracted: r.get::<_, i64>(9)? != 0,
            allocated: r.get(10)?,
            bill_id: r.get(11)?,
        })
    }))?;
    db(rows.collect::<rusqlite::Result<Vec<_>>>())
}

/// Every payment link, joined to its bank row for the date. A link whose bank row is gone
/// (a duplicate cleanup deleted it) pays nothing.
fn load_links(conn: &rusqlite::Connection) -> Result<Vec<core::Link>, String> {
    let mut stmt = db(conn.prepare(
        "SELECT p.id, p.bill_id, p.bank_txn_id, COALESCE(p.period,''), COALESCE(p.status,'auto'), \
                substr(t.posted_at,1,10), COALESCE(p.amount,0) \
         FROM bill_payments p JOIN bank_txn t ON t.id = p.bank_txn_id \
         ORDER BY p.created_at, p.id",
    ))?;
    let rows = db(stmt.query_map([], |r| {
        Ok(core::Link {
            id: r.get(0)?,
            bill_id: r.get(1)?,
            bank_txn_id: r.get(2)?,
            period: r.get(3)?,
            status: r.get(4)?,
            posted_at: r.get(5)?,
            amount: r.get(6)?,
        })
    }))?;
    db(rows.collect::<rusqlite::Result<Vec<_>>>())
}

/// The newest date the bank feed has reached (pending rows do not count): an unpaid due date
/// past it is "not seen", never overdue.
fn feed_latest(conn: &rusqlite::Connection) -> Result<Option<NaiveDate>, String> {
    let latest: Option<String> = db(conn.query_row(
        &format!("SELECT MAX(substr(t.posted_at,1,10)) FROM bank_txn t WHERE NOT ({PENDING})"),
        [],
        |r| r.get(0),
    ))?;
    Ok(latest.and_then(|s| core::parse_day(&s)))
}

/// Every link id that exists in any status: a rejected link is never written again.
fn known_link_ids(conn: &rusqlite::Connection) -> Result<HashSet<String>, String> {
    let mut stmt = db(conn.prepare("SELECT id FROM bill_payments"))?;
    let rows = db(stmt.query_map([], |r| r.get::<_, String>(0)))?;
    Ok(db(rows.collect::<rusqlite::Result<Vec<_>>>())?.into_iter().collect())
}

// ------------------------------------------------------------------------------ writes

fn to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Number(n) => n
            .as_i64()
            .map(rusqlite::types::Value::Integer)
            .unwrap_or_else(|| rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))),
        Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
        _ => rusqlite::types::Value::Null,
    }
}

/// Write the row, then tell the other devices. A create that finds the id already there (another
/// pass wrote the same link a moment ago) changes nothing and says nothing: `false`.
fn write(conn: &rusqlite::Connection, table: &str, id: &str, cols: Map<String, Value>, create: bool) -> Result<bool, String> {
    let keys: Vec<&String> = cols.keys().collect();
    let params: Vec<rusqlite::types::Value> = cols.values().map(to_sql).collect();
    let changed = if create {
        let sql = format!(
            "INSERT OR IGNORE INTO {table} (id, {}) VALUES (?1, {})",
            keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "),
            (2..=keys.len() + 1).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
        );
        let mut all = vec![rusqlite::types::Value::Text(id.to_string())];
        all.extend(params);
        db(conn.execute(&sql, rusqlite::params_from_iter(all.iter())))?
    } else {
        let sets: Vec<String> = keys.iter().enumerate().map(|(i, k)| format!("{k}=?{}", i + 1)).collect();
        let sql = format!("UPDATE {table} SET {} WHERE id=?{}", sets.join(", "), keys.len() + 1);
        let mut all = params;
        all.push(rusqlite::types::Value::Text(id.to_string()));
        db(conn.execute(&sql, rusqlite::params_from_iter(all.iter())))?
    };
    if changed == 0 {
        return Ok(false);
    }
    crate::sync::record_upsert(table, id, cols).map_err(|e| {
        tracing::warn!("bills: could not record {table} {id}: {e}");
        BUSY.to_string()
    })?;
    Ok(true)
}

fn now_string() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// The signed-in person's id, for `created_by`.
fn actor() -> String {
    crate::employees::session_actor().map(|(id, _)| id).unwrap_or_default()
}

/// Write the links `auto_links` chose. Every column goes out on a create. `created_by` is
/// 'system': nobody chose these.
fn write_auto_links(conn: &rusqlite::Connection, links: &[core::NewLink]) -> Result<usize, String> {
    let org = crate::employees::session_org_id();
    let now = now_string();
    let mut wrote = 0;
    for l in links {
        let mut cols = Map::new();
        cols.insert("org_id".into(), json!(org));
        cols.insert("bill_id".into(), json!(l.bill_id));
        cols.insert("bank_txn_id".into(), json!(l.bank_txn_id));
        cols.insert("period".into(), json!(l.period));
        cols.insert("amount".into(), json!(l.amount));
        cols.insert("status".into(), json!("auto"));
        cols.insert("created_by".into(), json!("system"));
        cols.insert("created_at".into(), json!(now));
        cols.insert("updated_at".into(), json!(now));
        if write(conn, "bill_payments", &l.id, cols, true)? {
            wrote += 1;
        }
    }
    Ok(wrote)
}

/// Link what the bank has for one bill. Returns how many links were written.
fn link_one(conn: &rusqlite::Connection, bill: &BillRow, today: NaiveDate) -> Result<usize, String> {
    if bill.status != "active" {
        return Ok(0);
    }
    let txns = load_txns(conn, &since(today, 400))?;
    let known = known_link_ids(conn)?;
    let stored = load_links(conn)?;
    let links = core::auto_links(&[bill.to_core()], &txns, &known, &stored);
    write_auto_links(conn, &links)
}

/// Link what the bank has for every active bill. Returns how many links were written.
fn link_all(conn: &rusqlite::Connection, today: NaiveDate) -> Result<usize, String> {
    let bills: Vec<core::Bill> = load_bills(conn)?.iter().filter(|b| b.status == "active").map(|b| b.to_core()).collect();
    if bills.is_empty() {
        return Ok(0);
    }
    let txns = load_txns(conn, &since(today, 400))?;
    let known = known_link_ids(conn)?;
    let stored = load_links(conn)?;
    let links = core::auto_links(&bills, &txns, &known, &stored);
    write_auto_links(conn, &links)
}

/// R-454: write the `period` of every live link of these bills whose stored copy is not the due
/// date its payment pays now (`core::period_fixes`), and send each change to the other devices.
/// Only `period` and `updated_at` go out. Returns how many links changed.
fn heal_periods(conn: &rusqlite::Connection, bill_ids: &[String]) -> Result<usize, String> {
    if bill_ids.is_empty() {
        return Ok(0);
    }
    let bills = load_bills(conn)?;
    let links = load_links(conn)?;
    let now = now_string();
    let mut changed = 0;
    for id in bill_ids {
        let Some(bill) = bills.iter().find(|b| &b.id == id) else { continue };
        for (pid, period) in core::period_fixes(&bill.to_core(), &links) {
            let mut cols = Map::new();
            cols.insert("period".into(), json!(period));
            cols.insert("updated_at".into(), json!(now));
            if write(conn, "bill_payments", &pid, cols, false)? {
                changed += 1;
            }
        }
    }
    Ok(changed)
}

/// One auto-link pass: link what the bank has for every active bill, then heal the due date every
/// active bill's links carry (this is what moves a payment stored under the wrong due date, like
/// rent missed on the 1st and paid on the 18th, to the right one). Returns how many links were
/// written and how many were moved.
fn auto_link_pass(conn: &rusqlite::Connection, today: NaiveDate) -> Result<(usize, usize), String> {
    let wrote = link_all(conn, today)?;
    let active: Vec<String> = load_bills(conn)?.into_iter().filter(|b| b.status == "active").map(|b| b.id).collect();
    let healed = heal_periods(conn, &active)?;
    Ok((wrote, healed))
}

/// Link every payment that belongs to a bill and has not been linked, and move the links that
/// pay the wrong due date. Called after a converged Plaid sync and after a pull that applied bills
/// events; idempotent, best effort. Tells the open screens when it wrote or moved a link, and
/// returns how many it wrote plus how many it moved.
pub fn run_auto_links() -> Result<usize, String> {
    // No store yet (early boot, or a test with no database): nothing to link.
    let Some(p) = crate::db::pool_opt() else { return Ok(0) };
    let conn = p.get().map_err(|e| e.to_string())?;
    let (wrote, healed) = auto_link_pass(&conn, crate::commands::central_today())?;
    if wrote + healed > 0 {
        tracing::info!("bills: linked {wrote} payment(s), moved {healed} to the due date they pay");
        announce();
    }
    Ok(wrote + healed)
}

// ------------------------------------------------------------------------------- JSON

fn state_json(st: &core::BillState) -> Value {
    json!({
        "status": st.status,
        "next_due": st.next_due,
        "days_until": st.days_until,
        "overdue": st.overdue,
        "last_paid": st.last_paid,
        "last_amount": st.last_amount,
        "current_paid": st.current_paid,
        "paid_count": st.paid_count,
        "on_time_count": st.on_time_count,
        "history": st.history.iter().map(|p| json!({
            "due": p.due, "paid_on": p.paid_on, "paid_amount": p.paid_amount, "state": p.state,
            "extra_amount": p.extra_amount,
        })).collect::<Vec<_>>(),
        "extras": st.extras.iter().map(|e| json!({ "posted_at": e.posted_at, "amount": e.amount })).collect::<Vec<_>>(),
        "extras_year": st.extras_year,
        "avg_amount": st.avg_amount,
        "avg_count": st.avg_count,
    })
}

fn bill_json(b: &BillRow, st: &core::BillState) -> Value {
    json!({
        "id": b.id, "name": b.name, "payee_match": b.payee_match, "amount": b.amount,
        "tolerance_pct": b.tolerance_pct, "cadence": b.cadence, "anchor_date": b.anchor_date,
        "category": b.category, "method": b.method, "website": b.website, "logo": b.logo,
        "notes": b.notes, "status": b.status, "created_at": b.created_at, "updated_at": b.updated_at,
        "monthly": core::monthly_equivalent(core::expected_amount(b.amount, st), &b.cadence),
        "state": state_json(st),
    })
}

/// Everything a bill's state is worked out from, read once.
struct Ctx {
    today: NaiveDate,
    feed: Option<NaiveDate>,
    bills: Vec<BillRow>,
    links: Vec<core::Link>,
}

impl Ctx {
    fn load(conn: &rusqlite::Connection, today: NaiveDate) -> Result<Ctx, String> {
        Ok(Ctx { today, feed: feed_latest(conn)?, bills: load_bills(conn)?, links: load_links(conn)? })
    }

    fn state(&self, b: &BillRow) -> core::BillState {
        core::bill_state(&b.to_core(), &self.links, self.today, self.feed)
    }

    fn out(&self, id: &str) -> Result<Value, String> {
        let b = self.bills.iter().find(|b| b.id == id && b.status != "ignored").ok_or_else(|| NOT_FOUND.to_string())?;
        Ok(bill_json(b, &self.state(b)))
    }
}

/// Every due date of `bill` from `lo` to `hi`. Nothing is due before the first due date.
fn dues_between(bill: &core::Bill, lo: NaiveDate, hi: NaiveDate) -> Vec<NaiveDate> {
    let Some(anchor) = core::parse_day(&bill.anchor) else { return Vec::new() };
    let mut out = Vec::new();
    let mut k = 0i64;
    loop {
        let d = core::occurrence(anchor, &bill.cadence, k);
        if d > hi || k > 5000 {
            break;
        }
        if d >= lo {
            out.push(d);
        }
        k += 1;
    }
    out
}

fn list_json(conn: &rusqlite::Connection, today: NaiveDate) -> Result<Value, String> {
    let c = Ctx::load(conn, today)?;
    let mut active: Vec<(&BillRow, core::BillState)> = Vec::new();
    let mut archived: Vec<(&BillRow, core::BillState)> = Vec::new();
    for b in &c.bills {
        match b.status.as_str() {
            "active" => active.push((b, c.state(b))),
            "archived" => archived.push((b, c.state(b))),
            _ => {}
        }
    }
    let by_due = |(b, st): &(&BillRow, core::BillState)| (st.next_due.clone().unwrap_or_else(|| "9999-12-31".into()), b.name.to_lowercase());
    active.sort_by_key(by_due);
    archived.sort_by_key(|(b, _)| b.name.to_lowercase());

    // R-454: the due dates paid are the ones the payments pay now, not the stored copies.
    let mut paid: HashSet<(String, String)> = HashSet::new();
    for b in &c.bills {
        for period in core::assign_periods(&b.to_core(), &c.links).into_values().filter(|p| !p.is_empty()) {
            paid.insert((b.id.clone(), period));
        }
    }
    let (month_lo, month_hi) = (first_of_month(today), last_of_month(today));
    let mut upcoming: Vec<(String, String, Value)> = Vec::new();
    let (mut paid_this_month, mut expected_this_month) = (0, 0);
    for (b, st) in &active {
        for d in dues_between(&b.to_core(), month_lo, today + Duration::days(45)) {
            let due = day_string(d);
            let is_paid = paid.contains(&(b.id.clone(), due.clone()));
            if d <= month_hi {
                expected_this_month += 1;
                if is_paid {
                    paid_this_month += 1;
                }
            }
            upcoming.push((due.clone(), b.name.to_lowercase(), json!({ "bill_id": b.id, "due": due, "amount": core::expected_amount(b.amount, st), "paid": is_paid })));
        }
    }
    upcoming.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));

    let mut monthly_total = 0.0;
    let (mut due_30_total, mut due_30_count) = (0.0, 0);
    let (mut overdue_total, mut overdue_count, mut due_soon_count) = (0.0, 0, 0);
    for (b, st) in &active {
        // R-455: a bill whose amount varies counts at what it costs on average.
        let expected = core::expected_amount(b.amount, st);
        monthly_total += core::monthly_equivalent(expected, &b.cadence);
        if st.days_until.map_or(false, |d| d <= 30) {
            due_30_total += expected;
            due_30_count += 1;
        }
        if !st.overdue.is_empty() {
            overdue_count += 1;
            overdue_total += expected * st.overdue.len() as f64;
        }
        if st.status == "due_soon" {
            due_soon_count += 1;
        }
    }

    let suggestions = candidates(conn, today)?.len();
    let bills: Vec<Value> = active.iter().chain(archived.iter()).map(|(b, st)| bill_json(b, st)).collect();
    Ok(json!({
        "today": day_string(today),
        "feed_latest": c.feed.map(day_string),
        "bills": bills,
        "summary": {
            "active": active.len(),
            "monthly_total": core::round2(monthly_total),
            "due_30_total": core::round2(due_30_total),
            "due_30_count": due_30_count,
            "overdue_count": overdue_count,
            "overdue_total": core::round2(overdue_total),
            "due_soon_count": due_soon_count,
            "paid_this_month": paid_this_month,
            "expected_this_month": expected_this_month,
        },
        "upcoming": upcoming.into_iter().map(|(_, _, v)| v).collect::<Vec<_>>(),
        "suggestions": suggestions,
    }))
}

fn alerts_json(conn: &rusqlite::Connection, today: NaiveDate) -> Result<Value, String> {
    let c = Ctx::load(conn, today)?;
    // By date, then by lowercase name (the server's order), so two bills due the same day list
    // the same on the Mac and on the phone.
    let mut over: Vec<(String, String, Value)> = Vec::new();
    let mut soon: Vec<(String, String, Value)> = Vec::new();
    for b in c.bills.iter().filter(|b| b.status == "active") {
        let st = c.state(b);
        let item = json!({
            "id": b.id, "name": b.name, "status": st.status, "next_due": st.next_due,
            "days_until": st.days_until, "overdue": st.overdue,
        });
        match st.status.as_str() {
            "overdue" => over.push((st.overdue.first().cloned().unwrap_or_default(), b.name.to_lowercase(), item)),
            "due_soon" => soon.push((st.next_due.clone().unwrap_or_default(), b.name.to_lowercase(), item)),
            _ => {}
        }
    }
    over.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    soon.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(json!({
        "overdue_count": over.len(),
        "due_soon_count": soon.len(),
        "items": over.into_iter().chain(soon).map(|(_, _, v)| v).collect::<Vec<_>>(),
    }))
}

fn get_json(conn: &rusqlite::Connection, id: &str, today: NaiveDate) -> Result<Value, String> {
    let c = Ctx::load(conn, today)?;
    let bill = c.out(id)?;
    // R-454: each live payment carries the due date it pays now ("" for an extra charge), worked out
    // from all of the bill's payments. An unlinked one keeps the copy it was stored with.
    let derived = c.bills.iter().find(|b| b.id == id).map(|b| core::assign_periods(&b.to_core(), &c.links)).unwrap_or_default();
    let mut stmt = db(conn.prepare(
        "SELECT p.id, p.bank_txn_id, COALESCE(p.period,''), COALESCE(p.status,'auto'), COALESCE(p.amount,0), \
                COALESCE(substr(t.posted_at,1,10),''), COALESCE(t.counterparty_name,''), COALESCE(t.description,''), \
                COALESCE(t.account_id,'') \
         FROM bill_payments p LEFT JOIN bank_txn t ON t.id = p.bank_txn_id \
         WHERE p.bill_id=?1 \
         ORDER BY COALESCE(substr(t.posted_at,1,10),'') DESC, p.created_at DESC, p.id",
    ))?;
    let rows = db(stmt.query_map([id], |r| {
        let pid: String = r.get(0)?;
        let status: String = r.get(3)?;
        let stored: String = r.get(2)?;
        let period = if status == "rejected" { stored } else { derived.get(&pid).cloned().unwrap_or(stored) };
        Ok(json!({
            "id": pid, "bank_txn_id": r.get::<_, String>(1)?, "extra": period.is_empty(), "period": period,
            "status": status, "amount": r.get::<_, f64>(4)?, "posted_at": r.get::<_, String>(5)?,
            "payee": r.get::<_, String>(6)?, "memo": r.get::<_, String>(7)?, "account_id": r.get::<_, String>(8)?,
        }))
    }))?;
    let payments = db(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    Ok(json!({ "bill": bill, "payments": payments }))
}

// ------------------------------------------------------------------------- detection

fn candidates(conn: &rusqlite::Connection, today: NaiveDate) -> Result<Vec<core::Candidate>, String> {
    let bills: Vec<core::Bill> = load_bills(conn)?.iter().map(|b| b.to_core()).collect();
    let txns = load_txns(conn, &since(today, 400))?;
    Ok(core::detect(&txns, &bills, today))
}

fn detect_json(conn: &rusqlite::Connection, today: NaiveDate) -> Result<Value, String> {
    let list: Vec<Value> = candidates(conn, today)?
        .iter()
        .map(|c| json!({
            "key": c.key, "name": c.name, "cadence": c.cadence, "amount": c.amount,
            "tolerance_pct": c.tolerance_pct, "anchor": c.anchor, "next_due": c.next_due,
            "category": c.category, "count": c.count, "first_paid": c.first_paid,
            "last_paid": c.last_paid, "monthly": c.monthly, "why": c.why,
        }))
        .collect();
    Ok(json!({ "candidates": list }))
}

/// Dismiss a suggestion: a bill row with status 'ignored' that holds its payee words, so
/// `detect` skips them from then on. It is never listed.
fn ignore(conn: &rusqlite::Connection, key: &str, name: &str) -> Result<(), String> {
    let key = key.trim();
    if core::words(key).is_empty() {
        return Err("There is nothing to ignore here.".into());
    }
    let taken = core::payee_key(key);
    if !taken.is_empty() && load_bills(conn)?.iter().any(|b| core::payee_key(&b.payee_match) == taken) {
        return Ok(());
    }
    let name = match name.trim() {
        "" => core::title_case(&taken),
        n => n.to_string(),
    };
    let now = now_string();
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!(crate::employees::session_org_id()));
    cols.insert("name".into(), json!(name));
    cols.insert("payee_match".into(), json!(key));
    cols.insert("amount".into(), json!(0.0));
    cols.insert("tolerance_pct".into(), json!(core::DEFAULT_TOLERANCE_PCT));
    cols.insert("cadence".into(), json!("monthly"));
    cols.insert("anchor_date".into(), json!(""));
    cols.insert("category".into(), json!(""));
    cols.insert("method".into(), json!(""));
    cols.insert("website".into(), json!(""));
    cols.insert("logo".into(), json!(""));
    cols.insert("notes".into(), json!(""));
    cols.insert("status".into(), json!("ignored"));
    cols.insert("created_by".into(), json!(actor()));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    write(conn, "bills", &uuid::Uuid::new_v4().to_string(), cols, true)?;
    Ok(())
}

// ----------------------------------------------------------------------------- save

const METHODS: &[&str] = &["zelle", "ach", "card", "check", "other", ""];
const STATUSES: &[&str] = &["active", "archived", "ignored"];
const LOGO_PREFIXES: &[&str] = &["data:image/png;base64,", "data:image/jpeg;base64,"];

/// A logo is empty, or a small PNG or JPEG data URL.
fn check_logo(logo: &str) -> Result<(), String> {
    if logo.is_empty() {
        return Ok(());
    }
    if logo.len() > core::MAX_LOGO_CHARS {
        return Err("That logo is too large. Try a smaller image.".into());
    }
    let Some(body) = LOGO_PREFIXES.iter().find_map(|p| logo.strip_prefix(p)) else {
        return Err("The logo must be a PNG or JPEG image.".into());
    };
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) {
        return Err("That logo is not a valid image. Try another one.".into());
    }
    Ok(())
}

/// The fields a save carried, checked. A key that is absent is `None` and changes nothing.
#[derive(Default)]
struct Fields {
    name: Option<String>,
    payee_match: Option<String>,
    amount: Option<f64>,
    tolerance_pct: Option<f64>,
    cadence: Option<String>,
    anchor_date: Option<String>,
    category: Option<String>,
    method: Option<String>,
    website: Option<String>,
    logo: Option<String>,
    notes: Option<String>,
    status: Option<String>,
}

fn text_of(v: &Value, key: &str) -> Result<Option<String>, String> {
    match v.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(String::new())),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
        Some(_) => Err("Some of the bill's details are not in the right form.".into()),
    }
}

fn number_of(v: &Value, key: &str) -> Result<Option<f64>, String> {
    let bad = || "Enter the amount and the amount band as numbers.".to_string();
    match v.get(key) {
        None => Ok(None),
        Some(Value::Number(n)) => Ok(Some(n.as_f64().ok_or_else(bad)?)),
        Some(Value::String(s)) => s.trim().replace(',', "").parse::<f64>().map(Some).map_err(|_| bad()),
        Some(_) => Err(bad()),
    }
}

fn parse_fields(v: &Value) -> Result<Fields, String> {
    if !v.is_object() {
        return Err("There is nothing to save.".into());
    }
    let mut f = Fields {
        name: text_of(v, "name")?,
        payee_match: text_of(v, "payee_match")?,
        amount: number_of(v, "amount")?,
        tolerance_pct: number_of(v, "tolerance_pct")?,
        cadence: text_of(v, "cadence")?,
        anchor_date: text_of(v, "anchor_date")?,
        category: text_of(v, "category")?,
        method: text_of(v, "method")?,
        website: text_of(v, "website")?,
        logo: text_of(v, "logo")?,
        notes: text_of(v, "notes")?,
        status: text_of(v, "status")?,
    };
    if let Some(a) = f.amount {
        if !a.is_finite() || a < 0.0 {
            return Err("The amount must be zero or more. Use zero if it changes each time.".into());
        }
        f.amount = Some(core::round2(a));
    }
    if let Some(t) = f.tolerance_pct {
        if !t.is_finite() || !(1.0..=50.0).contains(&t) {
            return Err("The amount band is a percentage from 1 to 50.".into());
        }
        f.tolerance_pct = Some(core::round2(t));
    }
    if let Some(c) = &f.cadence {
        if !core::CADENCES.contains(&c.as_str()) {
            return Err("Pick how often the bill comes due.".into());
        }
    }
    if let Some(a) = &f.anchor_date {
        match NaiveDate::parse_from_str(a, "%Y-%m-%d") {
            Ok(d) => f.anchor_date = Some(day_string(d)),
            Err(_) => return Err("Enter the first due date as a real date.".into()),
        }
    }
    if let Some(m) = &f.method {
        if !METHODS.contains(&m.as_str()) {
            return Err("Pick a payment method from the list.".into());
        }
    }
    if let Some(s) = &f.status {
        if !STATUSES.contains(&s.as_str()) {
            return Err("That status is not recognized.".into());
        }
    }
    if let Some(l) = &f.logo {
        check_logo(l)?;
    }
    Ok(f)
}

fn set_text(cols: &mut Map<String, Value>, key: &str, new: &Option<String>, old: &str) {
    if let Some(n) = new {
        if n != old {
            cols.insert(key.into(), json!(n));
        }
    }
}

fn set_number(cols: &mut Map<String, Value>, key: &str, new: Option<f64>, old: f64) {
    if let Some(n) = new {
        if (n - old).abs() > 1e-9 {
            cols.insert(key.into(), json!(n));
        }
    }
}

/// Create (`id` None) or update a bill, then link what the bank already has for it.
fn save(conn: &rusqlite::Connection, id: Option<&str>, fields: &Value, today: NaiveDate) -> Result<Value, String> {
    let f = parse_fields(fields)?;
    let now = now_string();
    let bill_id = match id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let cur = load_bill(conn, id)?;
            let mut cols = Map::new();
            if let Some(n) = &f.name {
                if n.is_empty() {
                    return Err("Give the bill a name.".into());
                }
            }
            set_text(&mut cols, "name", &f.name, &cur.name);
            // An emptied "shows in the bank as" falls back to the name, like a new bill.
            let payee = f.payee_match.as_ref().map(|p| if p.is_empty() { f.name.clone().unwrap_or_else(|| cur.name.clone()) } else { p.clone() });
            if let Some(p) = &payee {
                if core::words(p).is_empty() {
                    return Err("Enter the words the bank shows for this payment, such as the payee's name.".into());
                }
            }
            set_text(&mut cols, "payee_match", &payee, &cur.payee_match);
            set_number(&mut cols, "amount", f.amount, cur.amount);
            set_number(&mut cols, "tolerance_pct", f.tolerance_pct, cur.tolerance_pct);
            set_text(&mut cols, "cadence", &f.cadence, &cur.cadence);
            if f.anchor_date.as_deref() == Some("") {
                return Err("Enter the first due date.".into());
            }
            set_text(&mut cols, "anchor_date", &f.anchor_date, &cur.anchor_date);
            set_text(&mut cols, "category", &f.category, &cur.category);
            set_text(&mut cols, "method", &f.method, &cur.method);
            set_text(&mut cols, "website", &f.website, &cur.website);
            // Never sent again unless it changed: a logo is up to 40 KB.
            set_text(&mut cols, "logo", &f.logo, &cur.logo);
            set_text(&mut cols, "notes", &f.notes, &cur.notes);
            set_text(&mut cols, "status", &f.status, &cur.status);
            if !cols.is_empty() {
                cols.insert("updated_at".into(), json!(now));
                write(conn, "bills", id, cols, false)?;
            }
            id.to_string()
        }
        None => {
            let name = f.name.clone().unwrap_or_default();
            if name.is_empty() {
                return Err("Give the bill a name.".into());
            }
            let payee = match f.payee_match.clone().unwrap_or_default() {
                p if p.is_empty() => name.clone(),
                p => p,
            };
            if core::words(&payee).is_empty() {
                return Err("Enter the words the bank shows for this payment, such as the payee's name.".into());
            }
            let Some(anchor) = f.anchor_date.clone().filter(|a| !a.is_empty()) else {
                return Err("Enter the first due date.".into());
            };
            let new_id = uuid::Uuid::new_v4().to_string();
            let mut cols = Map::new();
            // A create event carries every column, or another device's insert writes nothing and
            // says nothing (decisions/a-create-event-carries-every-not-null-column).
            cols.insert("org_id".into(), json!(crate::employees::session_org_id()));
            cols.insert("name".into(), json!(name));
            cols.insert("payee_match".into(), json!(payee));
            cols.insert("amount".into(), json!(f.amount.unwrap_or(0.0)));
            cols.insert("tolerance_pct".into(), json!(f.tolerance_pct.unwrap_or(core::DEFAULT_TOLERANCE_PCT)));
            cols.insert("cadence".into(), json!(f.cadence.clone().unwrap_or_else(|| "monthly".into())));
            cols.insert("anchor_date".into(), json!(anchor));
            cols.insert("category".into(), json!(f.category.clone().unwrap_or_default()));
            cols.insert("method".into(), json!(f.method.clone().unwrap_or_default()));
            cols.insert("website".into(), json!(f.website.clone().unwrap_or_default()));
            cols.insert("logo".into(), json!(f.logo.clone().unwrap_or_default()));
            cols.insert("notes".into(), json!(f.notes.clone().unwrap_or_default()));
            cols.insert("status".into(), json!(f.status.clone().unwrap_or_else(|| "active".into())));
            cols.insert("created_by".into(), json!(actor()));
            cols.insert("created_at".into(), json!(now));
            cols.insert("updated_at".into(), json!(now));
            write(conn, "bills", &new_id, cols, true)?;
            new_id
        }
    };
    let bill = load_bill(conn, &bill_id)?;
    let linked = link_one(conn, &bill, today)?;
    // Moving the first due date or the cadence moves the due dates, and a new payment can change
    // which due date an older one pays: write the periods that are now stale (R-454).
    heal_periods(conn, &[bill_id.clone()])?;
    let c = Ctx::load(conn, today)?;
    Ok(json!({ "bill": c.out(&bill_id)?, "linked": linked }))
}

fn archive(conn: &rusqlite::Connection, id: &str, archived: bool, today: NaiveDate) -> Result<Value, String> {
    let cur = load_bill(conn, id)?;
    let want = if archived { "archived" } else { "active" };
    if cur.status != want {
        let mut cols = Map::new();
        cols.insert("status".into(), json!(want));
        cols.insert("updated_at".into(), json!(now_string()));
        write(conn, "bills", id, cols, false)?;
    }
    let c = Ctx::load(conn, today)?;
    Ok(json!({ "bill": c.out(id)? }))
}

// ------------------------------------------------------------------- picking payments


/// The payments Jack can link to a bill by hand. Without `q`: the unlinked payments of the last 120
/// days that could be this bill's, best match first, at most 40. With `q` (R-454): any payment of
/// any date that went out, matching every word of `q`, newest first, at most 60; one that already
/// pays another bill is listed with that bill's name in `linked_to` and cannot be picked. Each row
/// says in `due` which due date it would pay ("" when it would be an extra charge).
fn candidates_json(conn: &rusqlite::Connection, id: &str, q: Option<&str>, today: NaiveDate) -> Result<Value, String> {
    let bill = load_bill(conn, id)?;
    let cb = bill.to_core();
    let q = q.unwrap_or("");
    let searching = !q.trim().is_empty();
    let txns = load_txns(conn, &if searching { String::new() } else { since(today, 120) })?;
    let mut rows: Vec<(bool, f64, &core::Txn)> = txns
        .iter()
        .filter(|t| core::eligible(t))
        .filter(|t| if searching { t.bill_id != bill.id && core::search_matches(t, q) } else { t.bill_id.is_empty() })
        .map(|t| (!core::words_match(&cb.payee_match, t), (t.amount - cb.amount).abs(), t))
        .collect();
    if searching {
        rows.sort_by(|a, b| b.2.posted_at.cmp(&a.2.posted_at).then(a.2.id.cmp(&b.2.id)));
    } else {
        rows.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .then(b.2.posted_at.cmp(&a.2.posted_at))
                .then(a.2.id.cmp(&b.2.id))
        });
    }
    let paid: HashSet<String> = core::assign_periods(&cb, &load_links(conn)?).into_values().filter(|p| !p.is_empty()).collect();
    let names: HashMap<String, String> = load_bills(conn)?.into_iter().map(|b| (b.id, b.name)).collect();
    let mut out = Vec::new();
    for (_, _, t) in rows.into_iter().take(if searching { 60 } else { 40 }) {
        let account: String = db(conn
            .query_row("SELECT COALESCE(account_id,'') FROM bank_txn WHERE id=?1", [&t.id], |r| r.get(0))
            .optional())?
            .unwrap_or_default();
        let due = core::parse_day(&t.posted_at).map(|d| core::assign_period(&cb, d, t.amount, true, &paid)).unwrap_or_default();
        let linked_to = if t.bill_id.is_empty() {
            Value::Null
        } else {
            json!(names.get(&t.bill_id).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| "another bill".to_string()))
        };
        out.push(json!({
            "id": t.id, "posted_at": t.posted_at, "amount": t.amount, "payee": t.payee,
            "memo": t.memo, "account_id": account, "due": due, "linked_to": linked_to,
        }));
    }
    Ok(json!({ "txns": out }))
}

fn preview_json(conn: &rusqlite::Connection, payee_match: &str, amount: f64, tolerance_pct: f64, today: NaiveDate) -> Result<Value, String> {
    let probe = core::Bill {
        payee_match: payee_match.to_string(),
        amount: if amount.is_finite() && amount > 0.0 { amount } else { 0.0 },
        tolerance_pct: if tolerance_pct.is_finite() && tolerance_pct > 0.0 { tolerance_pct.min(50.0) } else { core::DEFAULT_TOLERANCE_PCT },
        status: "active".into(),
        ..Default::default()
    };
    let txns = load_txns(conn, &since(today, 400))?;
    let mut hits: Vec<&core::Txn> = txns
        .iter()
        .filter(|t| core::eligible(t) && core::words_match(&probe.payee_match, t) && core::amount_matches(&probe, t.amount))
        .collect();
    hits.sort_by(|a, b| b.posted_at.cmp(&a.posted_at).then(a.id.cmp(&b.id)));
    Ok(json!({
        "count": hits.len(),
        "txns": hits.iter().take(8).map(|t| json!({
            "id": t.id, "posted_at": t.posted_at, "amount": t.amount, "payee": t.payee,
        })).collect::<Vec<_>>(),
    }))
}

/// The name of the other bill a bank row already pays, if it pays one besides `bill_id`.
fn paid_to_another(conn: &rusqlite::Connection, bank_txn_id: &str, bill_id: &str) -> Result<Option<String>, String> {
    let other: Option<String> = db(conn
        .query_row(
            "SELECT COALESCE(NULLIF(b.name,''), 'another bill') FROM bill_payments p LEFT JOIN bills b ON b.id = p.bill_id \
             WHERE p.bank_txn_id=?1 AND p.status<>'rejected' AND p.bill_id<>?2 ORDER BY p.created_at, p.id LIMIT 1",
            [bank_txn_id, bill_id],
            |r| r.get(0),
        )
        .optional())?;
    Ok(other)
}

/// Link a payment to a bill by hand. It pays the latest due date on or before it that nothing else
/// pays, else the next one at any time before it; a payment the amount band does not fit is an extra
/// charge (R-454).
fn link(conn: &rusqlite::Connection, bill_id: &str, bank_txn_id: &str) -> Result<(), String> {
    let bill = load_bill(conn, bill_id)?;
    let Some((posted, amount, direction)): Option<(String, f64, String)> = db(conn
        .query_row(
            "SELECT substr(posted_at,1,10), amount, direction FROM bank_txn WHERE id=?1",
            [bank_txn_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?
    else {
        return Err("That payment was not found.".into());
    };
    if direction != "out" {
        return Err("Only money that went out can pay a bill.".into());
    }
    if let Some(name) = paid_to_another(conn, bank_txn_id, bill_id)? {
        return Err(format!("That payment is already linked to {name}."));
    }
    let id = core::link_id(bill_id, bank_txn_id);
    let now = now_string();
    let existing: Option<(String, String)> = db(conn
        .query_row("SELECT COALESCE(status,''), COALESCE(period,'') FROM bill_payments WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional())?;
    // The due dates the bill's other live payments pay now keep them.
    let cb = bill.to_core();
    let paid: HashSet<String> = core::assign_periods(&cb, &load_links(conn)?)
        .into_iter()
        .filter(|(pid, p)| *pid != id && !p.is_empty())
        .map(|(_, p)| p)
        .collect();
    let period = core::parse_day(&posted).map(|d| core::assign_period(&cb, d, amount, true, &paid)).unwrap_or_default();
    match existing {
        Some((status, old_period)) => {
            // The link may predate a change to the bill's due dates: pay the due date it pays now.
            let mut cols = Map::new();
            if status != "confirmed" {
                cols.insert("status".into(), json!("confirmed"));
            }
            if period != old_period {
                cols.insert("period".into(), json!(period));
            }
            if !cols.is_empty() {
                cols.insert("updated_at".into(), json!(now));
                write(conn, "bill_payments", &id, cols, false)?;
            }
        }
        None => {
            let mut cols = Map::new();
            cols.insert("org_id".into(), json!(crate::employees::session_org_id()));
            cols.insert("bill_id".into(), json!(bill_id));
            cols.insert("bank_txn_id".into(), json!(bank_txn_id));
            cols.insert("period".into(), json!(period));
            cols.insert("amount".into(), json!(core::round2(amount)));
            cols.insert("status".into(), json!("confirmed"));
            cols.insert("created_by".into(), json!(actor()));
            cols.insert("created_at".into(), json!(now));
            cols.insert("updated_at".into(), json!(now));
            write(conn, "bill_payments", &id, cols, true)?;
        }
    }
    // Adding this payment can change which due date a neighbour pays.
    heal_periods(conn, &[bill_id.to_string()])?;
    Ok(())
}

/// Reject (unlink) or restore a payment link. A link is never deleted.
fn set_link_status(conn: &rusqlite::Connection, pid: &str, status: &str) -> Result<(), String> {
    let Some((bill_id, txn_id, current)): Option<(String, String, String)> = db(conn
        .query_row(
            "SELECT COALESCE(bill_id,''), COALESCE(bank_txn_id,''), COALESCE(status,'') FROM bill_payments WHERE id=?1",
            [pid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?
    else {
        return Err("That payment link was not found.".into());
    };
    if status == "confirmed" {
        if let Some(name) = paid_to_another(conn, &txn_id, &bill_id)? {
            return Err(format!("That payment is already linked to {name}."));
        }
    }
    if current != status {
        let mut cols = Map::new();
        cols.insert("status".into(), json!(status));
        cols.insert("updated_at".into(), json!(now_string()));
        write(conn, "bill_payments", pid, cols, false)?;
    }
    // A payment taken off or put back changes which due date the others pay.
    heal_periods(conn, &[bill_id])?;
    Ok(())
}

// ------------------------------------------------------------------------- spending

/// Money out that counts as spending: a payment on a bill, an operating expense, a tax or
/// licence that is a real deduction, or shipping, packaging and storage. The chart of accounts
/// is `PNL_CATEGORY_GROUPS`, read here and never retyped.
fn spending_categories() -> Vec<&'static str> {
    let mut cats: Vec<&'static str> = PNL_CATEGORY_GROUPS
        .iter()
        .filter(|(v, _, group)| *group == "Operating expenses" || (*group == "Taxes & licences" && !PNL_TAX_PASSTHROUGH.contains(v)))
        .map(|(v, _, _)| *v)
        .collect();
    for c in ["shipping", "packaging", "storage"] {
        if !cats.contains(&c) {
            cats.push(c);
        }
    }
    cats
}

/// Money-out rows from `lo` to `hi` that are posted and still have something left after deal
/// allocations, with the bill each pays. `extra` narrows them (an SQL predicate over `t` and `p`).
fn out_rows(conn: &rusqlite::Connection, lo: &str, hi: &str, extra: &str) -> Result<Vec<core::SpendRow>, String> {
    let labels: HashMap<&str, &str> = PNL_CATEGORY_GROUPS.iter().map(|(v, label, _)| (*v, *label)).collect();
    let sql = format!(
        "SELECT id, day, rem, category, payee, memo, bill_id, bill_name FROM ( \
            SELECT t.id AS id, substr(t.posted_at,1,10) AS day, {REMAINDER} AS rem, COALESCE(t.category,'') AS category, \
                   COALESCE(t.counterparty_name,'') AS payee, COALESCE(t.description,'') AS memo, \
                   COALESCE(p.bill_id,'') AS bill_id, COALESCE(b.name,'') AS bill_name \
            FROM bank_txn t \
            LEFT JOIN bill_payments p ON p.id = {LIVE_LINK} \
            LEFT JOIN bills b ON b.id = p.bill_id \
            WHERE t.direction='out' AND substr(t.posted_at,1,10) >= ?1 AND substr(t.posted_at,1,10) <= ?2 \
              AND NOT ({PENDING}) AND NOT ({RETRACTED}) AND ({extra}) \
         ) WHERE rem > 0.005 ORDER BY day, id"
    );
    let mut stmt = db(conn.prepare(&sql))?;
    let rows = db(stmt.query_map([lo, hi], |r| {
        let category: String = r.get(3)?;
        Ok(core::SpendRow {
            id: r.get(0)?,
            posted_at: r.get(1)?,
            amount: r.get(2)?,
            label: String::new(),
            category,
            payee: r.get(4)?,
            memo: r.get(5)?,
            bill_id: r.get(6)?,
            bill_name: r.get(7)?,
        })
    }))?;
    let mut rows = db(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    for r in rows.iter_mut() {
        r.label = labels.get(r.category.as_str()).map(|l| l.to_string()).unwrap_or_default();
    }
    Ok(rows)
}

fn report_json(r: &core::SpendReport) -> Value {
    json!({
        "total": r.total, "prev_total": r.prev_total, "fixed": r.fixed, "other": r.other,
        "by_category": r.by_category.iter().map(|c| json!({
            "category": c.category, "label": c.label, "amount": c.amount, "prev_amount": c.prev_amount, "count": c.count,
        })).collect::<Vec<_>>(),
        "by_payee": r.by_payee.iter().map(|p| json!({
            "payee": p.payee, "bill_id": p.bill_id, "amount": p.amount, "count": p.count,
        })).collect::<Vec<_>>(),
        "months": r.months.iter().map(|m| json!({ "month": m.month, "fixed": m.fixed, "other": m.other })).collect::<Vec<_>>(),
        "insights": r.insights.iter().map(|i| json!({ "kind": i.kind, "text": i.text })).collect::<Vec<_>>(),
    })
}

fn f64_at(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// The months Analytics already reports for the range: deal profit, shipping, bank fees, true net.
fn range_months(range: &Value) -> Vec<core::ProfitMonth> {
    range
        .get("monthly_profit")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .map(|m| core::ProfitMonth {
                    month: m.get("month").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    profit: f64_at(m, "profit"),
                    shipping: f64_at(m, "shipping"),
                    fees: f64_at(m, "fees"),
                    true_net: f64_at(m, "true_net"),
                    ..Default::default()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Shipping already inside the profit of the deals the range counts (the same population
/// `get_analytics_range` counts). Shown for context only.
fn shipping_in_deals(conn: &rusqlite::Connection, from: &str, to: &str) -> Result<f64, String> {
    let sql = format!(
        "SELECT COALESCE(SUM(df.shipping_cost),0) FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
           AND {DF_SURVIVOR_SQL} AND (?1='' OR date(df.completed_at) >= ?1) AND (?2='' OR date(df.completed_at) <= ?2)"
    );
    db(conn.query_row(&sql, [from, to], |r| r.get(0)))
}

/// Where the money went between `from` and `to`, what is still unbooked, and true profit by month.
async fn spending_at(from: &str, to: &str) -> Result<Value, String> {
    let (Ok(from_d), Ok(to_d)) = (NaiveDate::parse_from_str(from.trim(), "%Y-%m-%d"), NaiveDate::parse_from_str(to.trim(), "%Y-%m-%d")) else {
        return Err("Pick a start date and an end date.".into());
    };
    if from_d > to_d {
        return Err("The start date must come before the end date.".into());
    }
    let (from, to) = (day_string(from_d), day_string(to_d));
    let days = (to_d - from_d).num_days() + 1;
    let prev_to = from_d - Duration::days(1);
    let prev_from = prev_to - Duration::days(days - 1);
    let (prev_from_s, prev_to_s) = (day_string(prev_from), day_string(prev_to));
    // The twelve months ending with `to`'s month start 11 months before it.
    let twelve = core::occurrence(first_of_month(to_d), "monthly", -11);
    let lo = day_string(prev_from.min(twelve));

    // Analytics' own figures for the range, read before this call takes a connection.
    let range = crate::commands::get_analytics_range(from.clone(), to.clone()).await?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    let cats = spending_categories().iter().map(|c| format!("'{c}'")).collect::<Vec<_>>().join(",");
    let rows = out_rows(&conn, &lo, &to, &format!("p.id IS NOT NULL OR t.category IN ({cats})"))?;
    let report = core::spending(&rows, &from, &to, &prev_from_s, &prev_to_s);

    let unbooked_rows: Vec<core::SpendRow> = out_rows(&conn, &from, &to, "COALESCE(t.category,'')='' AND p.id IS NULL")?;
    let unbooked_amount: f64 = unbooked_rows.iter().map(|r| r.amount).sum();

    let analytics_months = range_months(&range);
    let mut months = core::true_profit(&analytics_months, &rows, &from, &to);
    // Analytics lists only the months inside the span of its deals, but its totals count the
    // shipping and bank fees of every month in the range. Give those outside months their own
    // shipping and fees (and a row of their own when that is all they have), so the rows add up
    // to the totals below.
    let known: HashSet<&str> = analytics_months.iter().map(|m| m.month.as_str()).collect();
    let overhead = crate::commands::bank_overhead_by_month(&conn, &from, &to);
    for m in months.iter_mut().filter(|m| !known.contains(m.month.as_str())) {
        let (ship, fee) = overhead.get(&m.month).copied().unwrap_or((0.0, 0.0));
        m.shipping = ship;
        m.fees = fee;
        m.true_net = m.profit - ship - fee;
        m.true_profit = core::round2(m.true_net - m.operating);
    }
    for (month, &(ship, fee)) in &overhead {
        if (core::round2(ship) != 0.0 || core::round2(fee) != 0.0) && !months.iter().any(|m| &m.month == month) {
            let true_net = -ship - fee;
            months.push(core::ProfitMonth {
                month: month.clone(), shipping: ship, fees: fee, true_net, true_profit: core::round2(true_net), ..Default::default()
            });
        }
    }
    months.sort_by(|a, b| a.month.cmp(&b.month));
    let operating = core::round2(months.iter().map(|m| m.operating).sum());
    // The four figures Analytics reports for the whole range, so true net here is the number on
    // Analytics. (The month list is trimmed to the trading span, the range figures are not.)
    let (profit, shipping, fees, true_net) = (
        core::round2(f64_at(&range, "total_profit")),
        core::round2(f64_at(&range, "total_shipping")),
        core::round2(f64_at(&range, "total_fees")),
        core::round2(f64_at(&range, "true_net")),
    );
    Ok(json!({
        "from": from, "to": to, "prev_from": prev_from_s, "prev_to": prev_to_s,
        "report": report_json(&report),
        "unbooked": { "count": unbooked_rows.len(), "amount": core::round2(unbooked_amount) },
        "profit": {
            "months": months.iter().map(|m| json!({
                "month": m.month, "profit": core::round2(m.profit), "shipping": core::round2(m.shipping),
                "fees": core::round2(m.fees), "true_net": core::round2(m.true_net),
                "operating": m.operating, "true_profit": m.true_profit,
            })).collect::<Vec<_>>(),
            "totals": {
                "profit": profit, "shipping": shipping, "fees": fees, "true_net": true_net,
                "operating": operating, "true_profit": core::round2(true_net - operating),
            },
            "shipping_in_deals": core::round2(shipping_in_deals(&conn, &from, &to)?),
        },
    }))
}

// ---------------------------------------------------------------------- the server

/// One call to the server as the signed-in account. A refusal comes back as the server's own
/// sentence when it sent one.
async fn server_call(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let (status, value) = crate::netsync::server_request(method, path, body).await.map_err(|e| {
        let s = e.to_string();
        if s.starts_with("Sign in") { s } else { "Could not reach the server. Check your connection and try again.".to_string() }
    })?;
    if !(200..300).contains(&status) {
        let said = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
        return Err(said.unwrap_or_else(|| match status {
            401 => "Sign in again to use Bills.".to_string(),
            403 => "Your account does not have permission for that.".to_string(),
            404 => "The server does not have that yet.".to_string(),
            _ => "The server could not do that. Try again in a moment.".to_string(),
        }));
    }
    Ok(value)
}

// ---------------------------------------------------------------------- the commands

#[tauri::command]
pub async fn bills_list() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    list_json(&conn, crate::commands::central_today())
}

#[tauri::command]
pub async fn bills_alerts() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    alerts_json(&conn, crate::commands::central_today())
}

#[tauri::command]
pub async fn bills_get(id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    get_json(&conn, &id, crate::commands::central_today())
}

/// Create (`id` None) or update (`id` Some) a bill. On an update only the keys sent change.
#[tauri::command]
pub async fn bills_save(id: Option<String>, fields: Value) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let out = save(&conn, id.as_deref(), &fields, crate::commands::central_today())?;
    announce();
    Ok(out)
}

#[tauri::command]
pub async fn bills_archive(id: String, archived: bool) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let out = archive(&conn, &id, archived, crate::commands::central_today())?;
    announce();
    Ok(out)
}

#[tauri::command]
pub async fn bills_detect() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    detect_json(&conn, crate::commands::central_today())
}

#[tauri::command]
pub async fn bills_ignore(key: String, name: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    ignore(&conn, &key, &name)?;
    announce();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn bills_candidates(id: String, q: Option<String>) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    candidates_json(&conn, &id, q.as_deref(), crate::commands::central_today())
}

#[tauri::command]
pub async fn bills_link(id: String, bank_txn_id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    link(&conn, &id, &bank_txn_id)?;
    announce();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn bills_reject(pid: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    set_link_status(&conn, &pid, "rejected")?;
    announce();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn bills_restore(pid: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    set_link_status(&conn, &pid, "confirmed")?;
    announce();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn bills_preview(payee_match: String, amount: f64, tolerance_pct: f64) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    preview_json(&conn, &payee_match, amount, tolerance_pct, crate::commands::central_today())
}

/// The website's icon, fetched and shrunk by the server (`GET /api/bills/icon`).
#[tauri::command]
pub async fn bills_icon(site: String) -> Result<Value, String> {
    let site = site.trim().to_string();
    if site.is_empty() {
        return Err("Enter the website first.".into());
    }
    let mut url = reqwest::Url::parse("http://server.invalid/api/bills/icon").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("site", &site);
    let path = format!("{}?{}", url.path(), url.query().unwrap_or_default());
    server_call("GET", &path, None).await
}

#[tauri::command]
pub async fn bills_spending(from: String, to: String) -> Result<Value, String> {
    spending_at(&from, &to).await
}

/// This person's phone notification preferences (`GET /api/push/prefs`).
#[tauri::command]
pub async fn push_prefs_get() -> Result<Value, String> {
    server_call("GET", "/api/push/prefs", None).await
}

/// Save this person's phone notification preferences (`PUT /api/push/prefs`).
#[tauri::command]
pub async fn push_prefs_set(prefs: Value) -> Result<Value, String> {
    if !prefs.is_object() {
        return Err("There is nothing to save.".into());
    }
    server_call("PUT", "/api/push/prefs", Some(prefs)).await
}

// ---------------------------------------------------------------- the post-pull hook

/// Bills events applied during one pull. Dropping it (the pull ended, however it ended) links the
/// payments the other device's bills and links now make possible, and tells the open screens.
#[derive(Default)]
pub struct PullHook {
    touched: bool,
}

impl PullHook {
    /// Note an event that has just been applied. Only bills and payment links matter.
    pub fn note(&mut self, ev: &SyncEvent) {
        if let SyncOp::Upsert { table, .. } = &ev.op {
            if table == "bills" || table == "bill_payments" {
                self.touched = true;
            }
        }
    }
}

impl Drop for PullHook {
    fn drop(&mut self) {
        if !self.touched {
            return;
        }
        // A pass that wrote a link has already told the screens. Otherwise the pull itself
        // changed a bill or a link, and they still need to read it again.
        match run_auto_links() {
            Ok(n) if n > 0 => {}
            Ok(_) => announce(),
            Err(e) => {
                tracing::warn!("bills: could not link payments after a pull: {e}");
                announce();
            }
        }
    }
}

// -------------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::Hlc;

    /// 2031 is a year no other test's rows are in (the test store is shared).
    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2031, 3, 10).unwrap()
    }

    /// Clears what these tests leave in the shared store, when it starts and when it ends, even
    /// if the test panics.
    struct Clean;

    fn clean() {
        let conn = pool().get().unwrap();
        for sql in [
            "DELETE FROM bills",
            "DELETE FROM bill_payments",
            "DELETE FROM bank_txn WHERE id LIKE 'bt-bills-%'",
            "DELETE FROM bank_allocation WHERE id LIKE 'ba-bills-%'",
            "DELETE FROM deal_flows WHERE id LIKE 'df-bills-%'",
            "DELETE FROM invoices WHERE id LIKE 'inv-bills-%'",
            "DELETE FROM clients WHERE id = 'c-bills'",
            "DELETE FROM netsync_outbound WHERE event_json LIKE '%\"table\":\"bills\"%' OR event_json LIKE '%\"table\":\"bill_payments\"%'",
        ] {
            conn.execute(sql, []).unwrap();
        }
    }

    impl Clean {
        fn new() -> Clean {
            clean();
            Clean
        }
    }

    impl Drop for Clean {
        fn drop(&mut self) {
            clean();
        }
    }

    fn txn(id: &str, day: &str, amount: f64, dir: &str, payee: &str, category: &str, raw_json: &str) {
        pool().get().unwrap().execute(
            "INSERT INTO bank_txn (id, account_id, posted_at, amount, direction, description, category, counterparty_name, raw_json, created_at, updated_at)
             VALUES (?1, 'Sample Checking', ?2, ?3, ?4, ?5, ?6, ?5, ?7, ?2, ?2)",
            rusqlite::params![format!("bt-bills-{id}"), day, amount, dir, payee, category, raw_json],
        ).unwrap();
    }

    fn bt(id: &str) -> String {
        format!("bt-bills-{id}")
    }

    fn rent_fields() -> Value {
        json!({ "name": "Oak Street Properties", "payee_match": "oak street", "amount": 2400.0, "cadence": "monthly", "anchor_date": "2031-01-01", "category": "rent", "method": "zelle" })
    }

    /// The columns of the newest queued sync event for a row.
    fn queued_columns(table: &str, row_id: &str) -> Map<String, Value> {
        let conn = pool().get().unwrap();
        let json: String = conn
            .query_row(
                "SELECT event_json FROM netsync_outbound WHERE event_json LIKE ?1 ORDER BY rowid DESC LIMIT 1",
                [format!("%\"table\":\"{table}\",\"row_id\":\"{row_id}\"%")],
                |r| r.get(0),
            )
            .unwrap();
        let ev: SyncEvent = serde_json::from_str(&json).unwrap();
        match ev.op {
            SyncOp::Upsert { columns, .. } => columns,
            _ => panic!("expected an upsert"),
        }
    }

    fn save_new(conn: &rusqlite::Connection, fields: Value) -> Value {
        save(conn, None, &fields, today()).unwrap()
    }

    #[test]
    fn migration_107_creates_both_tables_with_the_spec_columns() {
        let _db = crate::db::init_test_store();
        let conn = pool().get().unwrap();
        let cols = |table: &str| -> Vec<String> {
            let mut stmt = conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}') ORDER BY cid")).unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(
            cols("bills"),
            ["id", "org_id", "name", "payee_match", "amount", "tolerance_pct", "cadence", "anchor_date", "category", "method", "website", "logo", "notes", "status", "created_by", "created_at", "updated_at"]
        );
        assert_eq!(
            cols("bill_payments"),
            ["id", "org_id", "bill_id", "bank_txn_id", "period", "amount", "status", "created_by", "created_at", "updated_at"]
        );
        // An empty insert works, so a create event can never be dropped for a missing column.
        conn.execute("INSERT INTO bills (id) VALUES ('bills-defaults')", []).unwrap();
        let (status, tol, cadence): (String, f64, String) = conn
            .query_row("SELECT status, tolerance_pct, cadence FROM bills WHERE id='bills-defaults'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!((status.as_str(), tol, cadence.as_str()), ("active", 10.0, "monthly"));
        conn.execute("DELETE FROM bills WHERE id='bills-defaults'", []).unwrap();
        // Registered for sync on both lists.
        assert!(crate::sync::is_synced_table("bills") && crate::sync::is_synced_table("bill_payments"));
    }

    #[test]
    fn a_save_then_a_list_round_trips_every_column() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        let mut fields = rent_fields();
        fields["website"] = json!("oakstreet.example");
        fields["notes"] = json!("Due on the 1st");
        fields["tolerance_pct"] = json!(5.0);
        let made = save_new(&conn, fields);
        assert_eq!(made["linked"], json!(0));
        let id = made["bill"]["id"].as_str().unwrap().to_string();

        let list = list_json(&conn, today()).unwrap();
        let bills = list["bills"].as_array().unwrap();
        assert_eq!(bills.len(), 1);
        let b = &bills[0];
        for (k, v) in [
            ("name", json!("Oak Street Properties")), ("payee_match", json!("oak street")), ("amount", json!(2400.0)),
            ("tolerance_pct", json!(5.0)), ("cadence", json!("monthly")), ("anchor_date", json!("2031-01-01")),
            ("category", json!("rent")), ("method", json!("zelle")), ("website", json!("oakstreet.example")),
            ("logo", json!("")), ("notes", json!("Due on the 1st")), ("status", json!("active")), ("monthly", json!(2400.0)),
        ] {
            assert_eq!(b[k], v, "{k}");
        }
        assert_eq!(b["id"], json!(id));
        assert!(!b["created_at"].as_str().unwrap().is_empty() && !b["updated_at"].as_str().unwrap().is_empty());
        assert_eq!(list["today"], json!("2031-03-10"));
        assert_eq!(list["summary"]["active"], json!(1));
        assert_eq!(list["summary"]["monthly_total"], json!(2400.0));
        // Nothing in the bank for it, and the feed has not reached 2031: unpaid, but not overdue.
        assert_eq!(b["state"]["status"], json!("not_seen"));

        // The create went out with every column, org_id and both dates included.
        let cols = queued_columns("bills", &id);
        for k in ["org_id", "name", "payee_match", "amount", "tolerance_pct", "cadence", "anchor_date", "category", "method", "website", "logo", "notes", "status", "created_by", "created_at", "updated_at"] {
            assert!(cols.contains_key(k), "the create event carries {k}");
        }

        // Required: a name, the words, a due date.
        assert_eq!(save(&conn, None, &json!({ "anchor_date": "2031-01-01" }), today()).unwrap_err(), "Give the bill a name.");
        assert_eq!(save(&conn, None, &json!({ "name": "Car note" }), today()).unwrap_err(), "Enter the first due date.");
        // The words default to the name.
        let defaulted = save_new(&conn, json!({ "name": "Pine Road Storage", "anchor_date": "2031-01-15" }));
        assert_eq!(defaulted["bill"]["payee_match"], json!("Pine Road Storage"));
        // Bad values are plain sentences.
        for (f, said) in [
            (json!({ "name": "A", "anchor_date": "2031-01-01", "cadence": "daily" }), "Pick how often the bill comes due."),
            (json!({ "name": "A", "anchor_date": "2031-01-01", "amount": -1 }), "The amount must be zero or more. Use zero if it changes each time."),
            (json!({ "name": "A", "anchor_date": "2031-01-01", "tolerance_pct": 51 }), "The amount band is a percentage from 1 to 50."),
            (json!({ "name": "A", "anchor_date": "2031-01-01", "tolerance_pct": 0 }), "The amount band is a percentage from 1 to 50."),
            (json!({ "name": "A", "anchor_date": "2031-02-30" }), "Enter the first due date as a real date."),
            (json!({ "name": "A", "anchor_date": "2031-01-01", "method": "barter" }), "Pick a payment method from the list."),
        ] {
            assert_eq!(save(&conn, None, &f, today()).unwrap_err(), said);
        }
    }

    #[test]
    fn an_update_writes_only_the_sent_keys_and_sends_only_the_changed_columns() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        let logo = format!("data:image/png;base64,{}", "iVBORw0KGgo".repeat(20));
        let mut fields = rent_fields();
        fields["logo"] = json!(logo);
        let id = save_new(&conn, fields)["bill"]["id"].as_str().unwrap().to_string();

        // Only the amount is sent, and the logo is sent again unchanged: neither the logo nor the
        // unsent keys go out.
        let out = save(&conn, Some(&id), &json!({ "amount": 2500.0, "logo": logo }), today()).unwrap();
        assert_eq!(out["bill"]["amount"], json!(2500.0));
        assert_eq!(out["bill"]["name"], json!("Oak Street Properties"));
        assert_eq!(out["bill"]["logo"], json!(logo));
        let cols = queued_columns("bills", &id);
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["amount", "updated_at"], "the update carries only what changed");

        // Nothing changed: nothing is written or sent.
        let before: i64 = conn.query_row("SELECT COUNT(*) FROM netsync_outbound", [], |r| r.get(0)).unwrap();
        save(&conn, Some(&id), &json!({ "amount": 2500.0, "name": "Oak Street Properties" }), today()).unwrap();
        let after: i64 = conn.query_row("SELECT COUNT(*) FROM netsync_outbound", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);

        // A name cannot be emptied and an unknown bill is not found.
        assert_eq!(save(&conn, Some(&id), &json!({ "name": "" }), today()).unwrap_err(), "Give the bill a name.");
        assert_eq!(save(&conn, Some("no-such-bill"), &json!({ "notes": "x" }), today()).unwrap_err(), "That bill was not found.");
    }

    #[test]
    fn a_logo_is_empty_or_a_small_png_or_jpeg() {
        assert!(check_logo("").is_ok());
        assert!(check_logo("data:image/png;base64,iVBORw0KGgo=").is_ok());
        assert!(check_logo("data:image/jpeg;base64,/9j/4AAQSkZJRg==").is_ok());
        assert_eq!(check_logo("data:image/svg+xml;base64,PHN2Zz4=").unwrap_err(), "The logo must be a PNG or JPEG image.");
        assert_eq!(check_logo("https://example.com/logo.png").unwrap_err(), "The logo must be a PNG or JPEG image.");
        assert_eq!(check_logo("data:image/png;base64,").unwrap_err(), "That logo is not a valid image. Try another one.");
        assert_eq!(check_logo("data:image/png;base64,<script>").unwrap_err(), "That logo is not a valid image. Try another one.");
        // The limit counts the whole data URL.
        let prefix = "data:image/png;base64,";
        let fits = format!("{prefix}{}", "A".repeat(core::MAX_LOGO_CHARS - prefix.len()));
        assert_eq!(fits.len(), core::MAX_LOGO_CHARS);
        assert!(check_logo(&fits).is_ok());
        assert_eq!(check_logo(&format!("{fits}A")).unwrap_err(), "That logo is too large. Try a smaller image.");
        // And a save refuses it before writing anything.
        let err = parse_fields(&json!({ "name": "A", "logo": format!("{fits}A") })).err().unwrap();
        assert_eq!(err, "That logo is too large. Try a smaller image.");
    }

    #[test]
    fn saving_a_bill_links_the_payments_the_bank_already_has() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        txn("feb", "2031-02-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES JPM99A", "", "");
        txn("jan", "2031-01-02T08:30:00", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES JPM98B", "", "");
        txn("other", "2031-02-01", 2400.0, "out", "ZELLE PAYMENT TO PINE ROAD LLC", "", "");
        txn("extra", "2031-02-02", 900.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("pending", "2031-03-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", r#"{"pnd":true}"#);
        txn("money_in", "2031-03-02", 2400.0, "in", "OAK STREET PROPERTIES REFUND", "", "");

        let out = save_new(&conn, rent_fields());
        // Two rent payments, and the 900.00 to the same payee, which fits no due date (R-453).
        assert_eq!(out["linked"], json!(3));
        let id = out["bill"]["id"].as_str().unwrap().to_string();
        let rows: Vec<(String, String, String, String, f64, String)> = {
            let mut stmt = conn.prepare("SELECT id, bill_id, period, status, amount, created_by FROM bill_payments ORDER BY id").unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, format!("bp-{id}-{}", bt("extra")));
        assert_eq!((rows[0].2.as_str(), rows[0].3.as_str(), rows[0].4), ("", "auto", 900.0), "an extra charge pays no due date");
        assert_eq!(rows[1].0, format!("bp-{id}-{}", bt("feb")));
        assert_eq!((rows[1].2.as_str(), rows[1].3.as_str(), rows[1].4, rows[1].5.as_str()), ("2031-02-01", "auto", 2400.0, "system"));
        assert_eq!(rows[2].2, "2031-01-01", "a posted_at with a time still pays its due date");
        let cols = queued_columns("bill_payments", &rows[1].0);
        for k in ["org_id", "bill_id", "bank_txn_id", "period", "amount", "status", "created_by", "created_at", "updated_at"] {
            assert!(cols.contains_key(k), "the link create carries {k}");
        }
        // The bank rows were not touched, and no allocation was written.
        let allocations: i64 = conn.query_row("SELECT COUNT(*) FROM bank_allocation WHERE bank_txn_id LIKE 'bt-bills-%'", [], |r| r.get(0)).unwrap();
        assert_eq!(allocations, 0);

        // Saving again links nothing new.
        let again = save(&conn, Some(&id), &json!({ "notes": "x" }), today()).unwrap();
        assert_eq!(again["linked"], json!(0));
        assert_eq!(run_auto_links_at(&conn), 0);

        // The state reads the links: Jan and Feb paid, March's feed reached Mar 2 so it is not yet overdue.
        let b = get_json(&conn, &id, today()).unwrap();
        assert_eq!(b["bill"]["state"]["paid_count"], json!(2), "an extra charge does not mark a due date paid");
        assert_eq!(b["payments"].as_array().unwrap().len(), 3);
        assert_eq!(b["payments"][0]["posted_at"], json!("2031-02-02"), "newest first");
        assert_eq!((b["payments"][0]["period"].clone(), b["payments"][0]["extra"].clone()), (json!(""), json!(true)));
        assert_eq!((b["payments"][1]["period"].clone(), b["payments"][1]["extra"].clone()), (json!("2031-02-01"), json!(false)));
    }

    fn run_auto_links_at(conn: &rusqlite::Connection) -> usize {
        link_all(conn, today()).unwrap()
    }

    #[test]
    fn a_rejected_link_is_not_made_again_and_can_be_restored() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        txn("feb", "2031-02-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        let out = save_new(&conn, rent_fields());
        assert_eq!(out["linked"], json!(1));
        let id = out["bill"]["id"].as_str().unwrap().to_string();
        let pid = core::link_id(&id, &bt("feb"));

        set_link_status(&conn, &pid, "rejected").unwrap();
        let status: String = conn.query_row("SELECT status FROM bill_payments WHERE id=?1", [&pid], |r| r.get(0)).unwrap();
        assert_eq!(status, "rejected");
        let cols = queued_columns("bill_payments", &pid);
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["status", "updated_at"], "a reject sends only the status");

        // Save the bill again, and run a whole pass: the rejection stands.
        assert_eq!(save(&conn, Some(&id), &json!({ "notes": "again" }), today()).unwrap()["linked"], json!(0));
        assert_eq!(run_auto_links_at(&conn), 0);
        let status: String = conn.query_row("SELECT status FROM bill_payments WHERE id=?1", [&pid], |r| r.get(0)).unwrap();
        assert_eq!(status, "rejected");
        // The rejected payment is listed, struck through by the screen, and the bill does not count it.
        let got = get_json(&conn, &id, today()).unwrap();
        assert_eq!(got["payments"][0]["status"], json!("rejected"));
        assert_eq!(got["bill"]["state"]["paid_count"], json!(0));
        // It is a candidate to pick by hand again.
        let cands = candidates_json(&conn, &id, None, today()).unwrap();
        assert_eq!(cands["txns"][0]["id"], json!(bt("feb")));
        assert_eq!(cands["txns"][0]["due"], json!("2031-02-01"));

        // Restoring it makes it confirmed.
        set_link_status(&conn, &pid, "confirmed").unwrap();
        assert_eq!(get_json(&conn, &id, today()).unwrap()["bill"]["state"]["paid_count"], json!(1));
        assert_eq!(set_link_status(&conn, "bp-none", "rejected").unwrap_err(), "That payment link was not found.");
    }

    #[test]
    fn a_hand_link_pays_the_due_date_it_was_late_for_and_refuses_a_payment_that_pays_another_bill() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        let rent = save_new(&conn, rent_fields())["bill"]["id"].as_str().unwrap().to_string();
        let storage = save_new(&conn, json!({ "name": "Pine Road Storage", "payee_match": "pine road", "amount": 300.0, "anchor_date": "2031-01-20" }))["bill"]["id"]
            .as_str().unwrap().to_string();
        // Mid-month and a different amount: no auto match, but Jack can link it.
        txn("odd", "2031-02-18", 2350.5, "out", "OAK STREET PROPERTIES PARTIAL", "", "");
        assert_eq!(candidates_json(&conn, &rent, None, today()).unwrap()["txns"][0]["id"], json!(bt("odd")), "the words match, so it is offered first");

        link(&conn, &rent, &bt("odd")).unwrap();
        let (period, status, by): (String, String, String) = conn
            .query_row("SELECT period, status, created_by FROM bill_payments WHERE id=?1", [core::link_id(&rent, &bt("odd"))], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        // Rent due Feb 1 and paid on Feb 18 pays Feb 1, the due date it was late for (R-454).
        assert_eq!((period.as_str(), status.as_str(), by.as_str()), ("2031-02-01", "confirmed", ""));
        // Not offered again, and the other bill cannot take it.
        assert!(candidates_json(&conn, &storage, None, today()).unwrap()["txns"].as_array().unwrap().iter().all(|t| t["id"] != json!(bt("odd"))));
        assert_eq!(link(&conn, &storage, &bt("odd")).unwrap_err(), "That payment is already linked to Oak Street Properties.");
        assert_eq!(link(&conn, &storage, "bt-bills-none").unwrap_err(), "That payment was not found.");
        txn("in", "2031-02-20", 50.0, "in", "OAK STREET PROPERTIES REFUND", "", "");
        assert_eq!(link(&conn, &rent, &bt("in")).unwrap_err(), "Only money that went out can pay a bill.");

        // Unlink it, then it can go to the other bill, and the first bill can take it back only by restore.
        let pid = core::link_id(&rent, &bt("odd"));
        set_link_status(&conn, &pid, "rejected").unwrap();
        link(&conn, &storage, &bt("odd")).unwrap();
        assert_eq!(set_link_status(&conn, &pid, "confirmed").unwrap_err(), "That payment is already linked to Pine Road Storage.");
        // Linking by hand a row that was rejected on this bill sets it back to confirmed.
        set_link_status(&conn, &core::link_id(&storage, &bt("odd")), "rejected").unwrap();
        link(&conn, &rent, &bt("odd")).unwrap();
        let status: String = conn.query_row("SELECT status FROM bill_payments WHERE id=?1", [&pid], |r| r.get(0)).unwrap();
        assert_eq!(status, "confirmed");
    }

    /// The first due date and the cadence are editable, and a payment link carries the due date it
    /// pays: left alone, every new due date reads as missed and the bill goes overdue.
    #[test]
    fn moving_the_first_due_date_moves_the_due_date_each_payment_pays() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        txn("jan", "2031-01-02", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("feb", "2031-02-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("mar", "2031-03-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        let made = save_new(&conn, rent_fields());
        assert_eq!(made["linked"], json!(3));
        let id = made["bill"]["id"].as_str().unwrap().to_string();
        let (jan, feb, mar) = (core::link_id(&id, &bt("jan")), core::link_id(&id, &bt("feb")), core::link_id(&id, &bt("mar")));
        let period = |pid: &str| -> String { conn.query_row("SELECT period FROM bill_payments WHERE id=?1", [pid], |r| r.get(0)).unwrap() };
        let status = |pid: &str| -> String { conn.query_row("SELECT status FROM bill_payments WHERE id=?1", [pid], |r| r.get(0)).unwrap() };
        assert_eq!((period(&jan), period(&feb), period(&mar)), ("2031-01-01".into(), "2031-02-01".into(), "2031-03-01".into()));
        set_link_status(&conn, &mar, "rejected").unwrap();

        let out = save(&conn, Some(&id), &json!({ "anchor_date": "2031-01-05" }), today()).unwrap();
        // The unlinked March payment keeps its copy: it pays nothing until it is restored.
        assert_eq!((period(&jan), period(&feb), period(&mar)), ("2031-01-05".into(), "2031-02-05".into(), "2031-03-01".into()));
        assert_eq!(status(&mar), "rejected", "moving a period never changes a link's status");
        assert_eq!(out["linked"], json!(0), "the payments stay linked, none is linked twice");
        let state = &out["bill"]["state"];
        assert_eq!(state["overdue"], json!([]));
        assert_ne!(state["status"], json!("overdue"));
        assert_eq!(state["paid_count"], json!(2));
        // Only the period went out.
        let cols = queued_columns("bill_payments", &jan);
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["period", "updated_at"]);
        assert_eq!(cols["period"], json!("2031-01-05"));

        // A change that leaves the due dates alone sends nothing about the links.
        let sent = || -> i64 {
            conn.query_row("SELECT COUNT(*) FROM netsync_outbound WHERE event_json LIKE '%\"table\":\"bill_payments\"%'", [], |r| r.get(0)).unwrap()
        };
        let before = sent();
        save(&conn, Some(&id), &json!({ "amount": 2500.0 }), today()).unwrap();
        assert_eq!(before, sent());

        // A hand link onto a link written under the old dates (say, by another device) pays today's date.
        conn.execute("UPDATE bill_payments SET period='2031-03-01' WHERE id=?1", [&mar]).unwrap();
        link(&conn, &id, &bt("mar")).unwrap();
        assert_eq!((period(&mar), status(&mar)), ("2031-03-05".into(), "confirmed".into()));
        let cols = queued_columns("bill_payments", &mar);
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["period", "status", "updated_at"]);
    }

    #[test]
    fn changing_the_cadence_moves_the_due_date_each_payment_pays() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        for (k, day) in [("w1", "2031-01-01"), ("w2", "2031-01-29"), ("w3", "2031-02-05"), ("w4", "2031-03-01")] {
            txn(k, day, 100.0, "out", "ZELLE PAYMENT TO IRON GYM", "", "");
        }
        let weekly = json!({ "name": "Iron Gym", "payee_match": "iron gym", "amount": 100.0, "cadence": "weekly", "anchor_date": "2031-01-01" });
        let made = save_new(&conn, weekly);
        assert_eq!(made["linked"], json!(4));
        let id = made["bill"]["id"].as_str().unwrap().to_string();

        let out = save(&conn, Some(&id), &json!({ "cadence": "monthly" }), today()).unwrap();
        let periods: Vec<String> = {
            let mut stmt = conn.prepare("SELECT p.period FROM bill_payments p JOIN bank_txn t ON t.id=p.bank_txn_id WHERE p.bill_id=?1 ORDER BY t.posted_at").unwrap();
            stmt.query_map([&id], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        // Feb 5 is a second payment in February: an extra charge, never a second paid due date.
        assert_eq!(periods, ["2031-01-01", "2031-02-01", "", "2031-03-01"]);
        let state = &out["bill"]["state"];
        assert_eq!(state["overdue"], json!([]));
        assert_eq!(state["paid_count"], json!(3));
        assert_eq!(state["extras"], json!([{ "posted_at": "2031-02-05", "amount": 100.0 }]));
        assert_eq!(state["status"], json!("paid"));
    }

    #[test]
    fn ignoring_a_suggestion_hides_it_and_the_ignored_row_is_never_a_bill() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        for (i, day) in ["2030-12-05", "2031-01-05", "2031-02-04", "2031-03-05"].iter().enumerate() {
            txn(&format!("pine{i}"), day, 300.0, "out", "ZELLE PAYMENT TO PINE ROAD STORAGE LLC", "", "");
        }
        let found = detect_json(&conn, today()).unwrap();
        let list = found["candidates"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["key"], json!("pine road storage"));
        assert_eq!(list[0]["name"], json!("Pine Road Storage"));
        assert_eq!(list[0]["cadence"], json!("monthly"));
        assert_eq!(list[0]["amount"], json!(300.0));
        assert_eq!(list[0]["count"], json!(4));
        assert!(list[0].get("txn_ids").is_none());
        assert_eq!(list_json(&conn, today()).unwrap()["suggestions"], json!(1));

        ignore(&conn, "pine road storage", "Pine Road Storage").unwrap();
        assert!(detect_json(&conn, today()).unwrap()["candidates"].as_array().unwrap().is_empty());
        let after = list_json(&conn, today()).unwrap();
        assert_eq!(after["suggestions"], json!(0));
        assert!(after["bills"].as_array().unwrap().is_empty(), "an ignored suggestion is never listed");
        assert_eq!(after["summary"]["active"], json!(0));
        // Ignoring it twice makes one row, it is not a bill to open, and it links nothing.
        ignore(&conn, "pine road storage", "Pine Road Storage").unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM bills WHERE status='ignored'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        let id: String = conn.query_row("SELECT id FROM bills", [], |r| r.get(0)).unwrap();
        assert_eq!(get_json(&conn, &id, today()).unwrap_err(), "That bill was not found.");
        assert_eq!(run_auto_links_at(&conn), 0);
        assert_eq!(ignore(&conn, "  ", "x").unwrap_err(), "There is nothing to ignore here.");
    }

    #[test]
    fn archiving_keeps_the_bill_listed_after_the_active_ones() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        let rent = save_new(&conn, rent_fields())["bill"]["id"].as_str().unwrap().to_string();
        save_new(&conn, json!({ "name": "Car note", "payee_match": "ally", "amount": 612.0, "anchor_date": "2031-01-05" }));
        let out = archive(&conn, &rent, true, today()).unwrap();
        assert_eq!(out["bill"]["status"], json!("archived"));
        assert_eq!(out["bill"]["state"]["status"], json!("archived"));
        let list = list_json(&conn, today()).unwrap();
        let names: Vec<&str> = list["bills"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Car note", "Oak Street Properties"]);
        assert_eq!(list["summary"]["active"], json!(1));
        assert_eq!(list["summary"]["monthly_total"], json!(612.0));
        // An archived bill links nothing, and bringing it back makes it active again.
        txn("late", "2031-03-01", 2400.0, "out", "OAK STREET PROPERTIES", "", "");
        assert_eq!(run_auto_links_at(&conn), 0);
        assert_eq!(archive(&conn, &rent, false, today()).unwrap()["bill"]["status"], json!("active"));
        assert_eq!(run_auto_links_at(&conn), 1);
    }

    #[test]
    fn the_list_summary_and_the_alerts_count_overdue_and_due_soon() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        // Rent is due on the 1st: Feb paid, March 1 (nine days ago) not paid. The bank reached Mar 9.
        txn("jan", "2031-01-01", 2400.0, "out", "OAK STREET PROPERTIES", "", "");
        txn("feb", "2031-02-01", 2400.0, "out", "OAK STREET PROPERTIES", "", "");
        txn("feed", "2031-03-09", 12.0, "out", "COFFEE SHOP", "meals", "");
        save_new(&conn, rent_fields());
        // A car note whose first payment is due on the 12th, two days from now.
        save_new(&conn, json!({ "name": "Car note", "payee_match": "ally", "amount": 612.0, "anchor_date": "2031-03-12" }));
        // Insurance, quarterly, first due Apr 20: nothing near.
        save_new(&conn, json!({ "name": "Insurance", "payee_match": "acme insurance", "amount": 150.0, "cadence": "quarterly", "anchor_date": "2031-04-20" }));

        let list = list_json(&conn, today()).unwrap();
        assert_eq!(list["feed_latest"], json!("2031-03-09"));
        let s = &list["summary"];
        assert_eq!(s["active"], json!(3));
        assert_eq!(s["overdue_count"], json!(1));
        assert_eq!(s["overdue_total"], json!(2400.0));
        assert_eq!(s["due_soon_count"], json!(1));
        // Monthly equivalents: 2400 + 612 + 150/3.
        assert_eq!(s["monthly_total"], json!(3062.0));
        // The car note (Mar 12) and rent's next due date (Apr 1) are within 30 days, insurance (Apr 20) is not.
        assert_eq!(s["due_30_count"], json!(2));
        assert_eq!(s["due_30_total"], json!(3012.0));
        // This month: rent on Mar 1 and the car note on Mar 12.
        assert_eq!(s["expected_this_month"], json!(2));
        assert_eq!(s["paid_this_month"], json!(0));
        // Active bills sort by their next due date, and every due date to today + 45 is listed.
        let names: Vec<&str> = list["bills"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Car note", "Oak Street Properties", "Insurance"]);
        let up = list["upcoming"].as_array().unwrap();
        assert_eq!(up[0], json!({ "bill_id": list["bills"][1]["id"], "due": "2031-03-01", "amount": 2400.0, "paid": false }));
        assert!(up.iter().all(|u| u["due"].as_str().unwrap() <= "2031-04-24"));
        assert!(up.windows(2).all(|w| w[0]["due"].as_str().unwrap() <= w[1]["due"].as_str().unwrap()));

        let alerts = alerts_json(&conn, today()).unwrap();
        assert_eq!((alerts["overdue_count"].clone(), alerts["due_soon_count"].clone()), (json!(1), json!(1)));
        assert_eq!(alerts["items"][0]["name"], json!("Oak Street Properties"));
        assert_eq!(alerts["items"][0]["status"], json!("overdue"));
        assert_eq!(alerts["items"][0]["overdue"], json!(["2031-03-01"]));
        assert_eq!(alerts["items"][1]["name"], json!("Car note"));
        assert_eq!(alerts["items"][1]["status"], json!("due_soon"));
        assert_eq!(alerts["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn two_alerts_on_the_same_day_list_by_name_like_the_server() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        // Zebra is created first and both are due on the 12th.
        save_new(&conn, json!({ "name": "Zebra Rent", "payee_match": "zebra", "amount": 900.0, "anchor_date": "2031-03-12" }));
        save_new(&conn, json!({ "name": "alpha Insurance", "payee_match": "alpha", "amount": 150.0, "anchor_date": "2031-03-12" }));
        let alerts = alerts_json(&conn, today()).unwrap();
        let names: Vec<&str> = alerts["items"].as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["alpha Insurance", "Zebra Rent"]);
    }

    #[test]
    fn the_preview_counts_every_match_and_shows_eight() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        for i in 0..10 {
            txn(&format!("p{i}"), &format!("2031-02-{:02}", i + 1), 100.0, "out", "ZELLE PAYMENT TO OAK STREET", "", "");
        }
        txn("small", "2031-02-15", 20.0, "out", "ZELLE PAYMENT TO OAK STREET", "", "");
        txn("pending", "2031-02-16", 100.0, "out", "ZELLE PAYMENT TO OAK STREET", "", r#"{"pnd":true}"#);
        txn("elsewhere", "2031-02-17", 100.0, "out", "ZELLE PAYMENT TO PINE ROAD", "", "");
        let p = preview_json(&conn, "oak street", 100.0, 10.0, today()).unwrap();
        assert_eq!(p["count"], json!(10));
        assert_eq!(p["txns"].as_array().unwrap().len(), 8);
        assert_eq!(p["txns"][0]["posted_at"], json!("2031-02-10"), "newest first");
        // Amount 0 checks the words only.
        assert_eq!(preview_json(&conn, "oak street", 0.0, 10.0, today()).unwrap()["count"], json!(11));
        assert_eq!(preview_json(&conn, "", 0.0, 10.0, today()).unwrap()["count"], json!(0));
    }

    #[test]
    fn the_pull_hook_notes_only_bills_events() {
        let event = |table: &str| SyncEvent {
            id: format!("ev-{table}"),
            hlc: Hlc { physical_ms: 1, logical: 0, node_id: [0; 8] },
            op: SyncOp::Upsert { table: table.into(), row_id: "x".into(), columns: Map::new() },
        };
        let mut h = PullHook::default();
        h.note(&event("freight_bookings"));
        h.note(&event("bank_txn"));
        assert!(!h.touched);
        h.note(&event("bill_payments"));
        assert!(h.touched);
        let mut h2 = PullHook::default();
        h2.note(&event("bills"));
        assert!(h2.touched);
        // Nothing to do when dropped here: the store has no bills.
        h.touched = false;
        h2.touched = false;
    }

    fn stored_period(conn: &rusqlite::Connection, pid: &str) -> String {
        conn.query_row("SELECT period FROM bill_payments WHERE id=?1", [pid], |r| r.get(0)).unwrap()
    }

    /// R-454: the warehouse payment missed on Aug 1 and paid on Aug 18 was stored under Sep 1. The
    /// next auto-link pass writes Aug 1 on it. The bill never read overdue because of it, and
    /// August reads late.
    #[test]
    fn a_late_payment_stored_under_the_next_due_date_moves_back_to_the_one_it_paid() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        let today = NaiveDate::from_ymd_opt(2031, 9, 5).unwrap();
        for (k, day) in [("jun", "2031-06-01"), ("jul", "2031-07-01"), ("aug", "2031-08-18"), ("sep", "2031-09-02")] {
            txn(k, day, 1800.0, "out", "ZELLE PAYMENT TO NORTH DOCK WAREHOUSE", "", "");
        }
        let fields = json!({ "name": "North Dock Warehouse", "payee_match": "north dock", "amount": 1800.0, "anchor_date": "2031-06-01" });
        let made = save(&conn, None, &fields, today).unwrap();
        assert_eq!(made["linked"], json!(4));
        let id = made["bill"]["id"].as_str().unwrap().to_string();
        let aug = core::link_id(&id, &bt("aug"));
        assert_eq!(stored_period(&conn, &aug), "2031-08-01", "a new link is written under the due date it pays");

        // How the older release stored it: under the next due date, beside the Sep 2 payment.
        conn.execute("UPDATE bill_payments SET period='2031-09-01' WHERE id=?1", [&aug]).unwrap();

        // Read before the pass, the bill already knows which due date each payment paid.
        let got = get_json(&conn, &id, today).unwrap();
        let aug_row = got["payments"].as_array().unwrap().iter().find(|p| p["id"] == json!(aug)).unwrap();
        assert_eq!((aug_row["period"].clone(), aug_row["extra"].clone()), (json!("2031-08-01"), json!(false)));
        let state = &got["bill"]["state"];
        assert_ne!(state["status"], json!("overdue"));
        assert_eq!(state["overdue"], json!([]));
        assert_eq!(state["paid_count"], json!(4));
        let history = state["history"].as_array().unwrap();
        let month = |due: &str| history.iter().find(|p| p["due"] == json!(due)).unwrap();
        assert_eq!((month("2031-08-01")["state"].clone(), month("2031-08-01")["paid_on"].clone()), (json!("late"), json!("2031-08-18")));
        assert_eq!(month("2031-09-01")["state"], json!("paid"));

        // The pass moves the stored copy, sends only that change, and a second pass changes nothing.
        let sent = || -> i64 {
            conn.query_row("SELECT COUNT(*) FROM netsync_outbound WHERE event_json LIKE '%\"table\":\"bill_payments\"%'", [], |r| r.get(0)).unwrap()
        };
        let before = sent();
        assert_eq!(auto_link_pass(&conn, today).unwrap(), (0, 1));
        assert_eq!(stored_period(&conn, &aug), "2031-08-01");
        let cols = queued_columns("bill_payments", &aug);
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["period", "updated_at"]);
        assert_eq!(cols["period"], json!("2031-08-01"));
        assert_eq!(sent(), before + 1);
        assert_eq!(auto_link_pass(&conn, today).unwrap(), (0, 0));
        assert_eq!(sent(), before + 1);
        assert_eq!(stored_period(&conn, &core::link_id(&id, &bt("sep"))), "2031-09-01");
        assert_eq!(list_json(&conn, today).unwrap()["summary"]["overdue_count"], json!(0));
    }

    /// R-453: a $5 charge in the middle of a $20 subscription is linked to the bill with no due date.
    /// It counts in the bill and in spending, and never marks a due date paid.
    #[test]
    fn an_extra_charge_links_with_no_due_date_and_never_marks_a_due_date_paid() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        for (k, day, amount) in [("jan", "2031-01-01", 20.0), ("feb", "2031-02-01", 20.0), ("top", "2031-02-17", 5.0), ("mar", "2031-03-01", 20.0)] {
            txn(k, day, amount, "out", "ANTHROPIC SUBSCRIPTION", "", "");
        }
        txn("coffee", "2031-02-18", 5.0, "out", "COFFEE SHOP", "meals", "");
        let made = save_new(&conn, json!({ "name": "Anthropic", "payee_match": "anthropic", "amount": 20.0, "anchor_date": "2031-01-01" }));
        assert_eq!(made["linked"], json!(4));
        let id = made["bill"]["id"].as_str().unwrap().to_string();
        let top = core::link_id(&id, &bt("top"));
        let (period, amount): (String, f64) = conn.query_row("SELECT period, amount FROM bill_payments WHERE id=?1", [&top], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((period.as_str(), amount), ("", 5.0));

        let got = get_json(&conn, &id, today()).unwrap();
        let state = &got["bill"]["state"];
        assert_eq!(state["paid_count"], json!(3));
        assert_eq!(state["extras"], json!([{ "posted_at": "2031-02-17", "amount": 5.0 }]));
        assert_eq!(state["extras_year"], json!(5.0));
        let history = state["history"].as_array().unwrap();
        let extra_in = |due: &str| history.iter().find(|p| p["due"] == json!(due)).unwrap()["extra_amount"].clone();
        assert_eq!((extra_in("2031-01-01"), extra_in("2031-02-01"), extra_in("2031-03-01")), (json!(0.0), json!(5.0), json!(0.0)));
        let payments = got["payments"].as_array().unwrap();
        let row = payments.iter().find(|p| p["id"] == json!(top)).unwrap();
        assert_eq!((row["period"].clone(), row["extra"].clone()), (json!(""), json!(true)));
        assert_eq!(payments.iter().filter(|p| p["extra"] == json!(true)).count(), 1);

        // It is bill money in Spending, beside the coffee that is not.
        let spend = out_rows(&conn, "2031-01-01", "2031-03-31", "1=1").unwrap();
        let on_bill = |k: &str| spend.iter().find(|r| r.id == bt(k)).unwrap().bill_id.clone();
        assert_eq!((on_bill("top"), on_bill("coffee")), (id.clone(), String::new()));

        // With the Feb 1 payment unlinked, the $5 does not pay February.
        set_link_status(&conn, &core::link_id(&id, &bt("feb")), "rejected").unwrap();
        let after = get_json(&conn, &id, today()).unwrap();
        assert_eq!(after["bill"]["state"]["paid_count"], json!(2));
        let history = after["bill"]["state"]["history"].as_array().unwrap().clone();
        let feb = history.iter().find(|p| p["due"] == json!("2031-02-01")).unwrap();
        assert_eq!((feb["state"].clone(), feb["paid_on"].clone(), feb["extra_amount"].clone()), (json!("missed"), json!(null), json!(5.0)));
    }

    /// R-454: a payment linked by hand pays the due date it was late for, and the next due date at
    /// any time before it when that one is taken.
    #[test]
    fn a_hand_link_fills_the_late_due_date_first_and_then_the_next_one() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        txn("jan", "2031-01-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        let rent = save_new(&conn, rent_fields())["bill"]["id"].as_str().unwrap().to_string();
        // Both arrive after the save, so nothing links them but Jack.
        txn("late", "2031-02-10", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("again", "2031-02-18", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        let cands = candidates_json(&conn, &rent, None, today()).unwrap();
        let due_of = |c: &Value, k: &str| c["txns"].as_array().unwrap().iter().find(|t| t["id"] == json!(bt(k))).unwrap()["due"].clone();
        assert_eq!((due_of(&cands, "late"), due_of(&cands, "again")), (json!("2031-02-01"), json!("2031-02-01")));

        link(&conn, &rent, &bt("late")).unwrap();
        assert_eq!(stored_period(&conn, &core::link_id(&rent, &bt("late"))), "2031-02-01");
        // The picker now says what the second one would pay.
        let cands = candidates_json(&conn, &rent, None, today()).unwrap();
        assert_eq!(due_of(&cands, "again"), json!("2031-03-01"));
        link(&conn, &rent, &bt("again")).unwrap();
        assert_eq!(stored_period(&conn, &core::link_id(&rent, &bt("again"))), "2031-03-01", "Jack's choice reaches the next due date, beyond the early window");
        assert_eq!(stored_period(&conn, &core::link_id(&rent, &bt("late"))), "2031-02-01", "linking the second does not move the first");
        assert_eq!(get_json(&conn, &rent, today()).unwrap()["bill"]["state"]["paid_count"], json!(3));
    }

    /// An unlinked payment pays no due date; putting it back works its due date out again.
    #[test]
    fn restoring_an_unlinked_payment_works_its_due_date_out_again() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        for (k, day) in [("jan", "2031-01-02"), ("feb", "2031-02-01"), ("mar", "2031-03-01")] {
            txn(k, day, 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        }
        let id = save_new(&conn, rent_fields())["bill"]["id"].as_str().unwrap().to_string();
        let mar = core::link_id(&id, &bt("mar"));
        set_link_status(&conn, &mar, "rejected").unwrap();
        save(&conn, Some(&id), &json!({ "anchor_date": "2031-01-05" }), today()).unwrap();
        assert_eq!(stored_period(&conn, &mar), "2031-03-01");
        set_link_status(&conn, &mar, "confirmed").unwrap();
        assert_eq!(stored_period(&conn, &mar), "2031-03-05");
        let cols = queued_columns("bill_payments", &mar);
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["period", "updated_at"], "the restore sends the status first, then the period it healed");
        assert_eq!(get_json(&conn, &id, today()).unwrap()["bill"]["state"]["paid_count"], json!(3));
    }


    /// R-454: every money-out payment of any date can be found by word, exact amount or month, and a
    /// payment that already pays another bill is shown with that bill's name.
    #[test]
    fn searching_finds_any_payment_and_names_the_bill_one_already_pays() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        let conn = pool().get().unwrap();
        let w = save_new(&conn, json!({ "name": "North Dock Warehouse", "payee_match": "north dock", "amount": 1500.0, "anchor_date": "2030-06-01" }))["bill"]["id"]
            .as_str().unwrap().to_string();
        let s = save_new(&conn, json!({ "name": "Pine Road Storage", "payee_match": "pine road", "amount": 300.0, "anchor_date": "2030-06-20" }))["bill"]["id"]
            .as_str().unwrap().to_string();
        let dock = "ZELLE PAYMENT TO NORTH DOCK WAREHOUSE";
        txn("w1", "2029-11-05", 1500.0, "out", dock, "", "");
        txn("w2", "2029-12-05", 1500.0, "out", dock, "", "");
        txn("w3", "2030-08-18", 1500.0, "out", dock, "", "");
        txn("recent", "2031-03-02", 1500.0, "out", dock, "", "");
        txn("mine", "2030-07-01", 1500.0, "out", dock, "", "");
        txn("taken", "2030-10-01", 300.0, "out", "PINE ROAD STORAGE", "", "");
        txn("in", "2030-08-20", 1500.0, "in", "REFUND NORTH DOCK WAREHOUSE", "", "");
        txn("pending", "2030-08-21", 1500.0, "out", dock, "", r#"{"pnd":true}"#);
        txn("deal", "2030-08-22", 1500.0, "out", dock, "payment", "");
        conn.execute("UPDATE bank_txn SET description='Security deposit hold' WHERE id=?1", [bt("w2")]).unwrap();
        link(&conn, &w, &bt("mine")).unwrap();
        link(&conn, &s, &bt("taken")).unwrap();

        let find = |bill: &str, q: Option<&str>| -> Vec<String> {
            let got = candidates_json(&conn, bill, q, today()).unwrap();
            got["txns"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().trim_start_matches("bt-bills-").to_string()).collect()
        };
        // By word: any date, newest first, never the ones this bill already pays or that cannot pay a bill.
        assert_eq!(find(&w, Some("warehouse")), ["recent", "w3", "w2", "w1"]);
        assert_eq!(find(&w, Some("WAREHOUSE")), ["recent", "w3", "w2", "w1"]);
        assert_eq!(find(&w, Some("security hold")), ["w2"], "the memo counts");
        assert_eq!(find(&w, Some("DEPOSIT")), ["w2"]);
        // By exact amount, written any way.
        for q in ["1500", "$1,500.00", "1500.00", "$1500"] {
            assert_eq!(find(&w, Some(q)), ["recent", "w3", "w2", "w1"], "{q}");
        }
        assert!(find(&w, Some("1500.5")).is_empty() && find(&w, Some("150")).is_empty());
        // By month or day, and every word has to match.
        assert_eq!(find(&w, Some("2029-11")), ["w1"]);
        assert_eq!(find(&w, Some("2029-12-05")), ["w2"]);
        assert_eq!(find(&w, Some("2030-08")), ["w3"]);
        assert!(find(&w, Some("warehouse 2029")).is_empty(), "2029 is read as an amount");
        assert_eq!(find(&w, Some("1500 2029-12 dock")), ["w2"]);
        assert!(find(&w, Some("warehouse 2031-04")).is_empty());
        // What each would pay: the late August payment pays Aug 1, a payment from before the bill's
        // first due date is an extra charge, and nothing here is linked to another bill.
        let got = candidates_json(&conn, &w, Some("warehouse"), today()).unwrap();
        let row = |k: &str| got["txns"].as_array().unwrap().iter().find(|t| t["id"] == json!(bt(k))).unwrap().clone();
        assert_eq!((row("w3")["due"].clone(), row("w1")["due"].clone()), (json!("2030-08-01"), json!("")));
        assert!(got["txns"].as_array().unwrap().iter().all(|t| t["linked_to"].is_null()));
        assert_eq!(row("w2")["account_id"], json!("Sample Checking"));

        // The other bill sees the payment that pays the warehouse, named, and its own is hidden.
        let got = candidates_json(&conn, &s, Some("warehouse"), today()).unwrap();
        let mine = got["txns"].as_array().unwrap().iter().find(|t| t["id"] == json!(bt("mine"))).unwrap().clone();
        assert_eq!((mine["linked_to"].clone(), mine["due"].clone()), (json!("North Dock Warehouse"), json!("")));
        assert!(find(&s, Some("pine")).is_empty());
        assert_eq!(find(&w, Some("pine")), ["taken"]);
        let taken = candidates_json(&conn, &w, Some("pine"), today()).unwrap();
        assert_eq!(taken["txns"][0]["linked_to"], json!("Pine Road Storage"));

        // No words, or only spaces: today's list, the last 120 days that no bill pays.
        assert_eq!(find(&w, None), ["recent"]);
        assert_eq!(find(&w, Some("   ")), ["recent"]);
        let list = candidates_json(&conn, &w, None, today()).unwrap();
        assert_eq!((list["txns"][0]["due"].clone(), list["txns"][0]["linked_to"].clone()), (json!("2031-03-01"), json!(null)));

        // A long history is cut to the newest sixty.
        for i in 0..65 {
            txn(&format!("bulk{i}"), &format!("2029-{:02}-{:02}", 1 + i / 28, 1 + i % 28), 17.0 + i as f64, "out", "BULK SUPPLY CO", "", "");
        }
        let many = find(&w, Some("bulk"));
        assert_eq!((many.len(), many[0].as_str(), many[59].as_str()), (60, "bulk64", "bulk5"));
        assert_eq!(find(&w, Some("17")), ["bulk0"], "an amount matches to the cent");
    }

    fn seed_deal(tag: &str, completed: &str, total_cost: f64, shipping_cost: f64) {
        let conn = pool().get().unwrap();
        conn.execute("INSERT OR IGNORE INTO clients (id, name, created_at, updated_at) VALUES ('c-bills', 'Sample buyer', '2031-01-01', '2031-01-01')", []).unwrap();
        conn.execute(
            "INSERT INTO invoices (id, client_id, number, issue_date, due_date, line_items_json, subtotal, total, created_at)
             VALUES (?1, 'c-bills', ?2, '2031-01-01', '2031-01-30', '[]', 10000, 10000, '2031-01-01')",
            rusqlite::params![format!("inv-bills-{tag}"), format!("INV-BILLS-{tag}")],
        ).unwrap();
        conn.execute(
            "INSERT INTO deal_flows (id, invoice_id, stage, created_at, updated_at, supplier_payments_json, total_supplier_cost, payment_received_amount, gross_revenue, total_cost, net_profit, shipping_cost, completed_at)
             VALUES (?1, ?2, 'complete', '2031-01-01', '2031-01-01', '[]', 6000, 10000, 10000, ?3, ?4, ?5, ?6)",
            rusqlite::params![format!("df-bills-{tag}"), format!("inv-bills-{tag}"), total_cost, 10000.0 - total_cost, shipping_cost, completed],
        ).unwrap();
    }

    /// Rent paid by Zelle is bill money, a coffee is spending by category, a bank fee and a postage
    /// charge come out of true net already, and the deal's own freight is never counted again.
    #[tokio::test]
    async fn spending_and_true_profit_agree_with_the_analytics_range() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        seed_deal("a", "2031-01-20", 7000.0, 800.0);
        seed_deal("b", "2031-02-10", 8000.0, 0.0);
        // Out of the range's trading span (before the first deal) so the month list is not the whole story.
        txn("rent1", "2031-01-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("rent2", "2031-02-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("rent3", "2031-03-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        txn("coffee", "2031-02-12", 40.0, "out", "COFFEE SHOP", "meals", "");
        txn("software", "2031-03-03", 25.0, "out", "ACME APPS", "software", "");
        txn("fee", "2031-02-14", 15.0, "out", "BANK WIRE FEE", "fee", "");
        txn("postage", "2031-02-15", 60.0, "out", "POSTAL SERVICE", "shipping", "");
        txn("goods", "2031-02-16", 5000.0, "out", "SUPPLIER PAYMENT", "payment", "");
        txn("untagged", "2031-02-17", 70.0, "out", "HARDWARE STORE", "", "");
        txn("owner", "2031-02-18", 500.0, "out", "OWNER DRAW", "owner_draw", "");
        txn("pending", "2031-02-19", 33.0, "out", "PENDING COFFEE", "meals", r#"{"pnd":true}"#);
        txn("refund", "2031-02-20", 10.0, "in", "COFFEE REFUND", "meals", "");
        // A coffee with half of it on a deal: only the rest is spending.
        txn("split", "2031-02-21", 100.0, "out", "LUNCH FOR A BUYER", "meals", "");
        pool().get().unwrap().execute(
            "INSERT INTO bank_allocation (id, bank_txn_id, deal_flow_id, amount, role) VALUES ('ba-bills-1', ?1, 'df-bills-a', 60, 'other')",
            [bt("split")],
        ).unwrap();
        {
            let conn = pool().get().unwrap();
            let rent = save_new(&conn, rent_fields());
            assert_eq!(rent["linked"], json!(3));
        }

        let out = spending_at("2031-01-01", "2031-03-31").await.unwrap();
        assert_eq!((out["from"].clone(), out["to"].clone()), (json!("2031-01-01"), json!("2031-03-31")));
        assert_eq!((out["prev_from"].clone(), out["prev_to"].clone()), (json!("2030-10-03"), json!("2030-12-31")));
        let r = &out["report"];
        // Rent 7,200 (bill money), coffee 40 + split 40, software 25, fee 15, postage 60.
        assert_eq!(r["fixed"], json!(7200.0));
        assert_eq!(r["other"], json!(180.0));
        assert_eq!(r["total"], json!(7380.0));
        let cats: HashMap<String, f64> = r["by_category"].as_array().unwrap().iter().map(|c| (c["category"].as_str().unwrap().to_string(), c["amount"].as_f64().unwrap())).collect();
        assert_eq!(cats.get("meals"), Some(&80.0));
        assert_eq!(cats.get("software"), Some(&25.0));
        assert_eq!(cats.get("fee"), Some(&15.0));
        assert_eq!(cats.get("shipping"), Some(&60.0));
        assert_eq!(cats.get("other_expense"), Some(&7200.0), "rent paid with no category is one 'other expense' line");
        for gone in ["payment", "owner_draw"] {
            assert!(!cats.contains_key(gone), "{gone} is not spending");
        }
        assert_eq!(r["by_payee"][0]["payee"], json!("Oak Street Properties"));
        assert_eq!(r["by_payee"][0]["amount"], json!(7200.0));
        assert_eq!(r["months"].as_array().unwrap().len(), 12);
        assert_eq!(r["months"][11], json!({ "month": "2031-03", "fixed": 2400.0, "other": 25.0 }));
        // Only the untagged 70.00 out is unbooked (the rest has a category, a deal or a bill).
        assert_eq!(out["unbooked"], json!({ "count": 1, "amount": 70.0 }));

        // True net is Analytics' own number, and so are the months it lists.
        let range = crate::commands::get_analytics_range("2031-01-01".into(), "2031-03-31".into()).await.unwrap();
        let p = &out["profit"];
        let true_net = range["true_net"].as_f64().unwrap();
        assert_eq!(p["totals"]["true_net"].as_f64().unwrap(), core::round2(true_net));
        assert_eq!(p["totals"]["profit"].as_f64().unwrap(), core::round2(range["total_profit"].as_f64().unwrap()));
        let month_sum: f64 = p["months"].as_array().unwrap().iter().map(|m| m["true_net"].as_f64().unwrap()).sum();
        assert_eq!(core::round2(month_sum), core::round2(true_net), "the months add up to the range when nothing sits outside the trading span");
        // Operating costs are everything but shipping and bank fees: rent 7,200 + meals 80 + software 25.
        assert_eq!(p["totals"]["operating"], json!(7305.0));
        assert_eq!(p["totals"]["true_profit"].as_f64().unwrap(), core::round2(true_net - 7305.0));
        // March has rent and no deal: it is still a month.
        let march = p["months"].as_array().unwrap().iter().find(|m| m["month"] == json!("2031-03")).unwrap();
        assert_eq!(march["operating"], json!(2425.0));
        assert_eq!(march["profit"], json!(0.0));
        assert_eq!(march["true_profit"], json!(-2425.0));
        // The shipping already inside the deals' profit, for context.
        assert_eq!(p["shipping_in_deals"], json!(800.0));

        assert_eq!(spending_at("2031-03-31", "2031-01-01").await.unwrap_err(), "The start date must come before the end date.");
        assert_eq!(spending_at("", "2031-01-01").await.unwrap_err(), "Pick a start date and an end date.");
    }

    /// Shipping and bank fees outside the span of the deals are in Analytics' totals but not in its
    /// months. The month rows carry them, so the rows add up to the Total row.
    #[tokio::test]
    async fn true_profit_months_add_up_to_the_totals_with_overhead_outside_the_trading_span() {
        let _db = crate::db::init_test_store();
        let _clean = Clean::new();
        seed_deal("a", "2031-02-10", 7000.0, 0.0);
        txn("shipjan", "2031-01-08", 400.0, "out", "CARRIER", "shipping", "");
        txn("shipfeb", "2031-02-12", 100.0, "out", "CARRIER", "shipping", "");
        txn("feemar", "2031-03-05", 20.0, "out", "WIRE FEE", "fee", "");
        txn("rentjan", "2031-01-01", 2400.0, "out", "ZELLE PAYMENT TO OAK STREET PROPERTIES", "", "");
        {
            let conn = pool().get().unwrap();
            assert_eq!(save_new(&conn, rent_fields())["linked"], json!(1));
        }
        let out = spending_at("2031-01-01", "2031-03-31").await.unwrap();
        let p = &out["profit"];
        let months = p["months"].as_array().unwrap();
        let totals = &p["totals"];
        assert_eq!((totals["shipping"].clone(), totals["fees"].clone()), (json!(500.0), json!(20.0)));
        for k in ["profit", "shipping", "fees", "true_net", "operating", "true_profit"] {
            let sum = core::round2(months.iter().map(|m| m[k].as_f64().unwrap()).sum());
            assert_eq!(sum, totals[k].as_f64().unwrap(), "the month rows add up to the total for {k}");
        }
        let month = |m: &str| months.iter().find(|x| x["month"] == json!(m)).unwrap_or_else(|| panic!("a row for {m}"));
        // January has no deal: its shipping and its rent both land on its row.
        let jan = month("2031-01");
        assert_eq!(
            (jan["shipping"].clone(), jan["true_net"].clone(), jan["operating"].clone(), jan["true_profit"].clone()),
            (json!(400.0), json!(-400.0), json!(2400.0), json!(-2800.0))
        );
        // March has only a bank fee: it still gets a row.
        let mar = month("2031-03");
        assert_eq!((mar["fees"].clone(), mar["true_net"].clone(), mar["true_profit"].clone()), (json!(20.0), json!(-20.0), json!(-20.0)));
        let order: Vec<&str> = months.iter().map(|m| m["month"].as_str().unwrap()).collect();
        assert_eq!(order, ["2031-01", "2031-02", "2031-03"]);
    }
}
