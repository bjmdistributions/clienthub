//! Buys (R-488): what was paid for one warehouse product or one delivery, and the cost each order
//! taken from it carries onto that order's deal.
//!
//! The shares and the bank plan are `buy_core.rs`, BYTE-IDENTICAL to the server's
//! `routes/buy_core.rs`. This file reads the rows, runs the plan and writes it; the server's
//! `routes/warehouse_buys.rs` does the same against its database, and the two reach each other
//! through sync.
//!
//! `apply` writes everything from scratch each time, so running it twice changes nothing:
//! - on each order's deal, a goods line `buyg-<order>` and, while no shipping payment covers it, a
//!   shipping line `buys-<order>` (notes start `Buy: `, which `is_buy_line` locks against hand
//!   edits);
//! - on each bank row paying the buy, a `supplier_payment` (goods) or `fee` (shipping) booking on
//!   every order it covers, and an `adjustment` held against the buy itself (deal_flow_id = the
//!   buy's id) for what no order has taken. The rows paying a buy are read back from those
//!   bookings, so a pending row settling into its posted twin (which moves the bookings) needs
//!   nothing from here.
//!
//! A person without the Financials edit switch (R-526) gets the lines but no bank bookings, since
//! the server would refuse their push of `bank_allocation`; the buy then reads "out of step" until
//! someone with the switch presses Bring up to date (or the server writes them).
//!
//! A buy is a reader, never a deal: no deal flow row is made for it, so no profit reader can count
//! it. Every order stays an ordinary invoice and deal flow.
//!
//! R-551: a buy may be started before its stock is here (On the way: no `item_id` and no `load_id`, and 0
//! units until the stock is attached) and is brought in on logistics trucks (`freight_bookings.buy_id`,
//! no deal). Its shipping in follows those trucks (`buy_core::truck_cost`, `ship_in`) and his markup on
//! them is laid on the orders like the shipping in. This desktop never writes a truck (the server does,
//! and the desktop's copy arrives through sync): it reads them here to price the buy, and the server
//! prices the same orders again whenever a truck changes.
use crate::buy_core::{self as core, Kind};
use crate::commands::SupplierPayment;
use crate::db::pool;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const BUYS: &str = "warehouse_buys";
const ORDERS: &str = "warehouse_buy_orders";

const NEEDS_FINANCIALS: &str = "Tying a bank payment to a buy needs the Financials switch on your role. An admin can turn it on in Settings, Team.";

type Conn = r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>;

fn conn() -> Result<Conn, String> {
    pool().get().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Rows

#[derive(Clone, Debug)]
struct BuyRow {
    id: String,
    item_id: String,
    load_id: String,
    name: String,
    supplier_id: String,
    supplier_name: String,
    units: f64,
    goods: f64,
    ship: f64,
    notes: String,
    archived: bool,
    created_at: String,
    updated_at: String,
}

const BUY_COLS: &str = "id, COALESCE(item_id,''), COALESCE(load_id,''), COALESCE(name,''), COALESCE(supplier_id,''), \
    COALESCE(supplier_name,''), COALESCE(units_bought,0), COALESCE(goods_total,0), COALESCE(ship_total,0), COALESCE(notes,''), \
    COALESCE(archived,0), created_at, updated_at";

fn map_buy(r: &rusqlite::Row) -> rusqlite::Result<BuyRow> {
    Ok(BuyRow {
        id: r.get(0)?,
        item_id: r.get(1)?,
        load_id: r.get(2)?,
        name: r.get(3)?,
        supplier_id: r.get(4)?,
        supplier_name: r.get(5)?,
        units: r.get(6)?,
        goods: r.get(7)?,
        ship: r.get(8)?,
        notes: r.get(9)?,
        archived: r.get::<_, i64>(10)? != 0,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

fn buy(c: &rusqlite::Connection, id: &str) -> Result<BuyRow, String> {
    c.query_row(&format!("SELECT {BUY_COLS} FROM warehouse_buys WHERE id=?1"), [id], map_buy)
        .map_err(|_| "That buy is no longer here.".to_string())
}

/// The live buy recorded on a product or a delivery, if any.
fn buy_for(c: &rusqlite::Connection, item_id: &str, load_id: &str) -> Option<BuyRow> {
    let (col, val) = if !item_id.is_empty() { ("item_id", item_id) } else { ("load_id", load_id) };
    if val.is_empty() {
        return None;
    }
    c.query_row(
        &format!("SELECT {BUY_COLS} FROM warehouse_buys WHERE {col}=?1 AND COALESCE(archived,0)=0 ORDER BY created_at LIMIT 1"),
        [val],
        map_buy,
    )
    .ok()
}

#[derive(Clone, Debug)]
struct OrderRow {
    id: String,
    invoice_id: String,
    count: f64,
    goods_typed: Option<f64>,
    own_cost: bool,
    undone: bool,
    created_at: String,
}

fn orders(c: &rusqlite::Connection, buy_id: &str) -> Vec<OrderRow> {
    let Ok(mut st) = c.prepare(
        "SELECT id, invoice_id, COALESCE(count,0), goods_typed, COALESCE(own_cost,0), COALESCE(undone,0), created_at \
         FROM warehouse_buy_orders WHERE buy_id=?1 ORDER BY created_at, id",
    ) else {
        return Vec::new();
    };
    let rows = st.query_map([buy_id], |r| {
        Ok(OrderRow {
            id: r.get(0)?,
            invoice_id: r.get(1)?,
            count: r.get(2)?,
            goods_typed: r.get(3)?,
            own_cost: r.get::<_, i64>(4)? != 0,
            undone: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
        })
    });
    rows.map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------
// Trucks (R-551)

/// One truck bringing a buy in (`freight_bookings.buy_id`), as the screens and the plan read it.
#[derive(Clone, Debug, Default)]
struct TruckFull {
    id: String,
    code: String,
    status: String,
    archived: bool,
    paid: Option<f64>,
    /// `quoted_cost`: the carrier rate.
    rate: Option<f64>,
    /// `quote_cost`: the carrier cost its quote was built on.
    quote_cost: Option<f64>,
    markup: Option<f64>,
    quote_amount: Option<f64>,
    carrier: String,
    bank_txn_id: String,
    pickup_date: String,
    delivery_date: String,
    delivery_window: String,
    delivery_appt_time: String,
    delivered_at: String,
    delivered_time: String,
}

impl TruckFull {
    fn truck_in(&self) -> core::TruckIn {
        core::TruckIn { status: self.status.clone(), archived: self.archived, paid: self.paid, rate: self.rate, quote_cost: self.quote_cost, markup: self.markup }
    }
}

/// A buy's trucks, oldest first (`created_at`, then id), the removed ones too (they cost nothing).
fn trucks_of(c: &rusqlite::Connection, buy_id: &str) -> Vec<TruckFull> {
    let Ok(mut st) = c.prepare(
        "SELECT id, COALESCE(load_number,''), status, COALESCE(archived,0), paid_amount, quoted_cost, quote_cost, markup_amount, quote_amount, \
                COALESCE(carrier,''), COALESCE(bank_txn_id,''), COALESCE(pickup_date,''), COALESCE(delivery_date,''), COALESCE(delivery_window,''), \
                COALESCE(delivery_appt_time,''), COALESCE(delivered_at,''), COALESCE(delivered_time,'') \
         FROM freight_bookings WHERE buy_id=?1 ORDER BY created_at, id",
    ) else {
        return Vec::new();
    };
    let rows = st.query_map([buy_id], |r| {
        let id: String = r.get(0)?;
        let number: String = r.get(1)?;
        Ok(TruckFull {
            code: crate::freight::booking_code_of(&id, &number),
            id,
            status: r.get(2)?,
            archived: r.get::<_, i64>(3)? != 0,
            paid: r.get(4)?,
            rate: r.get(5)?,
            quote_cost: r.get(6)?,
            markup: r.get(7)?,
            quote_amount: r.get(8)?,
            carrier: r.get(9)?,
            bank_txn_id: r.get(10)?,
            pickup_date: r.get(11)?,
            delivery_date: r.get(12)?,
            delivery_window: r.get(13)?,
            delivery_appt_time: r.get(14)?,
            delivered_at: r.get(15)?,
            delivered_time: r.get(16)?,
        })
    });
    rows.map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

/// What a buy's trucks cost (`buy_core::truck_cost`): his markup on them counts only while the logistics pay rule is on and
/// paying (the server's `pays_markup`).
fn truck_cost_of(trucks: &[TruckFull]) -> core::TruckCost {
    let ins: Vec<core::TruckIn> = trucks.iter().map(TruckFull::truck_in).collect();
    core::truck_cost(&ins, crate::freight::pays_markup())
}

/// The buy's totals: its goods, its shipping in (the trucks once it has one) and his markup on them.
fn totals_of(b: &BuyRow, tc: &core::TruckCost) -> core::Totals {
    core::Totals { units: b.units, goods: b.goods, ship: core::ship_in(b.ship, tc), markup: tc.markup }
}

/// The trucks as the screens list them (`TruckRow`): the removed ones left out, `truck_no` the place among the live ones (0 for
/// a cancelled one) and `trucks` how many are live.
fn truck_rows(trucks: &[TruckFull], tc: &core::TruckCost) -> Vec<Value> {
    let mut place = 0;
    trucks
        .iter()
        .filter(|t| !t.archived)
        .map(|t| {
            let live = t.truck_in().live();
            if live {
                place += 1;
            }
            json!({
                "id": t.id, "code": t.code, "status": t.status, "truck_no": if live { place } else { 0 }, "trucks": tc.live,
                "carrier": t.carrier, "rate": core::truck_carrier(&t.truck_in()), "paid": t.paid, "markup": t.markup,
                "quote_amount": t.quote_amount, "bank_txn_id": t.bank_txn_id, "pickup_date": t.pickup_date,
                "delivery_date": t.delivery_date, "delivery_window": t.delivery_window, "delivery_appt_time": t.delivery_appt_time,
                "delivered_at": t.delivered_at, "delivered_time": t.delivered_time,
            })
        })
        .collect()
}

/// The deal of an invoice: the one every list shows (highest stage, newest on a tie).
fn deal_of(c: &rusqlite::Connection, invoice_id: &str) -> Option<String> {
    c.query_row(
        "SELECT id FROM deal_flows WHERE invoice_id=?1 AND COALESCE(archived,0)=0 \
         ORDER BY (CASE stage WHEN 'complete' THEN 3 WHEN 'supplier_paid' THEN 2 WHEN 'payment_received' THEN 1 ELSE 0 END) DESC, created_at DESC LIMIT 1",
        [invoice_id],
        |r| r.get(0),
    )
    .ok()
}

/// A booking this buy owns on one bank row.
#[derive(Clone, Debug)]
struct Alloc {
    id: String,
    org_id: String,
    txn_id: String,
    deal: String,
    amount: f64,
    role: String,
    note: String,
    created_by: String,
    created_at: String,
}

fn allocs_where(c: &rusqlite::Connection, clause: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<Alloc> {
    let sql = format!(
        "SELECT a.id, COALESCE(a.org_id,''), a.bank_txn_id, a.deal_flow_id, COALESCE(a.amount,0), COALESCE(a.role,''), COALESCE(a.note,''), \
                COALESCE(a.created_by,''), COALESCE(a.created_at,'') FROM bank_allocation a WHERE {clause}"
    );
    let Ok(mut st) = c.prepare(&sql) else { return Vec::new() };
    let rows = st.query_map(params, |r| {
        Ok(Alloc {
            id: r.get(0)?,
            org_id: r.get(1)?,
            txn_id: r.get(2)?,
            deal: r.get(3)?,
            amount: r.get(4)?,
            role: r.get(5)?,
            note: r.get(6)?,
            created_by: r.get(7)?,
            created_at: r.get(8)?,
        })
    });
    rows.map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

/// Every booking the buy owns, on itself and on its orders' deals: the ids it gives them all start
/// `alloc_<buy id>_` (`buy_core::alloc_id`), so two buys on one deal never take each other's.
fn owned_allocs(c: &rusqlite::Connection, buy_id: &str) -> Vec<Alloc> {
    let prefix = core::alloc_prefix(buy_id);
    allocs_where(c, "substr(a.id, 1, length(?1)) = ?1", &[&prefix])
}

fn kind_of(a: &Alloc) -> Kind {
    match a.role.as_str() {
        "fee" => Kind::Ship,
        "supplier_payment" => Kind::Goods,
        _ => core::held_kind(&a.note),
    }
}

#[derive(Clone, Debug)]
struct TxnInfo {
    amount: f64,
    posted_at: String,
    name: String,
    source_format: String,
    /// Booked to anything that is not this buy.
    others: f64,
}

fn txn_info(c: &rusqlite::Connection, id: &str, owned_ids: &BTreeSet<String>) -> Option<TxnInfo> {
    let (amount, posted_at, name, source_format) = c
        .query_row(
            "SELECT COALESCE(amount,0), COALESCE(posted_at,''), COALESCE(NULLIF(TRIM(counterparty_name),''), description, ''), COALESCE(source_format,'') \
             FROM bank_txn WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
        )
        .ok()?;
    let others = core::total(allocs_where(c, "a.bank_txn_id=?1", &[&id]).iter().filter(|a| !owned_ids.contains(&a.id)).map(|a| a.amount));
    Some(TxnInfo { amount, posted_at, name, source_format, others })
}

// ---------------------------------------------------------------------------------------
// The stock a buy sits on

fn stock_left(c: &rusqlite::Connection, b: &BuyRow) -> (f64, String) {
    if !b.item_id.is_empty() {
        let row: Option<(String, String, String)> = c
            .query_row(
                "SELECT COALESCE(name,''), COALESCE(sections_json,'[]'), COALESCE(box_types_json,'[]') FROM warehouse_items WHERE id=?1",
                [&b.item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        return match row {
            Some((name, s, t)) => (item_units(&s, &t), name),
            None => (0.0, String::new()),
        };
    }
    let row: Option<(String, String)> = c
        .query_row("SELECT COALESCE(name,''), COALESCE(lines_json,'[]') FROM warehouse_loads WHERE id=?1", [&b.load_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    match row {
        Some((name, lines)) => (load_pairs_left(c, &b.load_id, &lines), name),
        None => (0.0, String::new()),
    }
}

fn item_units(sections_json: &str, types_json: &str) -> f64 {
    use crate::warehouse_core as wc;
    let mut types: Vec<wc::BoxType> = serde_json::from_str(types_json).unwrap_or_default();
    let mut sections: Vec<wc::Section> = serde_json::from_str(sections_json).unwrap_or_default();
    wc::upgrade(&mut types, &mut sections);
    core::total(sections.iter().map(|s| wc::units_of(&types, s) as f64))
}

fn load_pairs_left(c: &rusqlite::Connection, load_id: &str, lines_json: &str) -> f64 {
    let lines: Vec<crate::case_core::LoadLine> = serde_json::from_str(lines_json).unwrap_or_default();
    let cases = crate::warehouse_loads::cases(c, load_id).unwrap_or_default();
    let outs = crate::warehouse_loads::outs(c, load_id).unwrap_or_default();
    crate::case_core::stock(&lines, &cases, &outs).left as f64
}

#[derive(Clone, Debug)]
struct Candidate {
    invoice_id: String,
    count: f64,
    at: String,
}

fn live_invoice(c: &rusqlite::Connection, invoice_id: &str) -> bool {
    c.query_row("SELECT 1 FROM invoices WHERE id=?1 AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0", [invoice_id], |_| Ok(())).is_ok()
}

fn invoice_by_number(c: &rusqlite::Connection, number: &str) -> Option<String> {
    c.query_row("SELECT id FROM invoices WHERE number=?1 AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 LIMIT 1", [number], |r| r.get(0)).ok()
}

/// Orders already taken from the stock that the buy does not have: invoices that took stock
/// before the buy was recorded, or whose cost did not reach the buy when they were made.
fn candidates(c: &rusqlite::Connection, b: &BuyRow, have: &[OrderRow]) -> Vec<Candidate> {
    let known: BTreeSet<&str> = have.iter().map(|o| o.invoice_id.as_str()).collect();
    let mut out: BTreeMap<String, Candidate> = BTreeMap::new();
    if !b.load_id.is_empty() {
        for o in crate::warehouse_loads::outs(c, &b.load_id).unwrap_or_default() {
            if o.undone || o.invoice_id.is_empty() || known.contains(o.invoice_id.as_str()) || !live_invoice(c, &o.invoice_id) {
                continue;
            }
            let e = out.entry(o.invoice_id.clone()).or_insert(Candidate { invoice_id: o.invoice_id.clone(), count: 0.0, at: o.created_at.clone() });
            e.count += o.pairs as f64;
        }
    } else if !b.item_id.is_empty() {
        let log: String = c.query_row("SELECT COALESCE(log_json,'[]') FROM warehouse_items WHERE id=?1", [&b.item_id], |r| r.get(0)).unwrap_or_else(|_| "[]".into());
        let moves: Vec<crate::warehouse_core::Move> = serde_json::from_str(&log).unwrap_or_default();
        for m in moves {
            if m.undone || m.kind != "out" || m.reference.trim().is_empty() {
                continue;
            }
            let Some(inv) = invoice_by_number(c, m.reference.trim()) else { continue };
            if known.contains(inv.as_str()) {
                continue;
            }
            let units: f64 = m.lines.iter().map(|l| (-l.units).max(0) as f64).sum();
            let e = out.entry(inv.clone()).or_insert(Candidate { invoice_id: inv.clone(), count: 0.0, at: m.at.clone() });
            e.count += units;
            if m.at < e.at {
                e.at = m.at.clone();
            }
        }
    }
    let mut v: Vec<Candidate> = out.into_values().filter(|c| c.count > 0.0).collect();
    v.sort_by(|a, b| a.at.cmp(&b.at));
    v
}

/// The deal already carries a supplier cost typed by hand (not one a buy wrote).
fn has_own_cost(c: &rusqlite::Connection, invoice_id: &str) -> bool {
    let Some(d) = deal_of(c, invoice_id) else { return false };
    let sp: String = c.query_row("SELECT COALESCE(supplier_payments_json,'[]') FROM deal_flows WHERE id=?1", [&d], |r| r.get(0)).unwrap_or_else(|_| "[]".into());
    let lines: Vec<SupplierPayment> = serde_json::from_str(&sp).unwrap_or_default();
    lines.iter().any(|p| p.category.as_deref().unwrap_or("supplier") == "supplier" && !p.kept && p.amount > 0.0 && !p.notes.as_deref().map_or(false, core::is_buy_note))
}

// ---------------------------------------------------------------------------------------
// Writing

fn to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Number(n) => n.as_i64().map(rusqlite::types::Value::Integer).unwrap_or_else(|| rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))),
        Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
        _ => rusqlite::types::Value::Null,
    }
}

/// Write the columns, then record the event (a create carries the author's org).
fn put(table: &str, id: &str, mut cols: Map<String, Value>, create: bool) -> Result<(), String> {
    if create {
        cols.insert("org_id".into(), json!(crate::employees::session_org_id()));
    }
    let c = conn()?;
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
        c.execute(&sql, rusqlite::params_from_iter(all.iter())).map_err(|e| e.to_string())?;
    } else {
        let sets: Vec<String> = keys.iter().enumerate().map(|(i, k)| format!("{k}=?{}", i + 1)).collect();
        let sql = format!("UPDATE {table} SET {} WHERE id=?{}", sets.join(", "), keys.len() + 1);
        let mut all = params;
        all.push(rusqlite::types::Value::Text(id.to_string()));
        c.execute(&sql, rusqlite::params_from_iter(all.iter())).map_err(|e| e.to_string())?;
    }
    drop(c);
    crate::sync::record_upsert(table, id, cols).map_err(|e| e.to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn alloc_cols(a: &Alloc, updated_at: &str) -> Map<String, Value> {
    let mut c = Map::new();
    c.insert("org_id".into(), json!(a.org_id));
    c.insert("bank_txn_id".into(), json!(a.txn_id));
    c.insert("deal_flow_id".into(), json!(a.deal));
    c.insert("amount".into(), json!(a.amount));
    c.insert("role".into(), json!(a.role));
    c.insert("note".into(), json!(a.note));
    c.insert("created_by".into(), json!(a.created_by));
    c.insert("created_at".into(), json!(a.created_at));
    c.insert("updated_at".into(), json!(updated_at));
    c
}

fn alloc_create(a: &Alloc) -> Result<(), String> {
    conn()?
        .execute(
            // The id is the same on every device (`buy_core::alloc_id`), so a booking another device
            // already wrote is brought to what is wanted rather than refused.
            "INSERT INTO bank_allocation (id, org_id, bank_txn_id, deal_flow_id, amount, role, note, created_by, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9) \
             ON CONFLICT(id) DO UPDATE SET bank_txn_id=excluded.bank_txn_id, deal_flow_id=excluded.deal_flow_id, amount=excluded.amount, role=excluded.role, note=excluded.note, updated_at=excluded.updated_at",
            rusqlite::params![a.id, a.org_id, a.txn_id, a.deal, a.amount, a.role, a.note, a.created_by, a.created_at],
        )
        .map_err(|e| e.to_string())?;
    crate::sync::record_upsert("bank_allocation", &a.id, alloc_cols(a, &a.created_at)).map_err(|e| e.to_string())
}

fn alloc_resize(a: &Alloc, amount: f64, note: &str) -> Result<(), String> {
    let t = now();
    conn()?
        .execute("UPDATE bank_allocation SET amount=?1, note=?2, updated_at=?3 WHERE id=?4", rusqlite::params![amount, note, t, a.id])
        .map_err(|e| e.to_string())?;
    // The full identifying set, so a peer that never saw the create still builds a whole row.
    let mut b = a.clone();
    b.amount = amount;
    b.note = note.to_string();
    crate::sync::record_upsert("bank_allocation", &a.id, alloc_cols(&b, &t)).map_err(|e| e.to_string())
}

fn alloc_remove(id: &str) -> Result<(), String> {
    crate::sync::record_delete("bank_allocation", id).map_err(|e| e.to_string())?;
    conn()?.execute("DELETE FROM bank_allocation WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug)]
struct Want {
    deal: String,
    txn_id: String,
    role: &'static str,
    amount: f64,
    note: String,
}

/// Everything `apply` read, the plan, and what it wants written. Read-only, so the screen can ask
/// whether the written state is out of step without changing anything (invariant 14).
struct Worked {
    b: BuyRow,
    ords: Vec<OrderRow>,
    deal_of_order: BTreeMap<String, String>,
    owned: Vec<Alloc>,
    rows: BTreeMap<String, (Kind, TxnInfo)>,
    /// R-551: what the buy cost (its shipping in follows its trucks), its trucks and what they cost.
    t: core::Totals,
    trucks: Vec<TruckFull>,
    tc: core::TruckCost,
    plan: core::Plan,
    wants: Vec<Want>,
    /// Per deal: the lines this buy's order on it should carry, the lines it carries now, the order.
    lines: BTreeMap<String, (Vec<SupplierPayment>, Vec<SupplierPayment>, String)>,
}

/// Whether a cost line is this order's (each buy writes only its own two ids on a deal).
fn is_ours(p: &SupplierPayment, order_id: &str) -> bool {
    p.id == core::goods_line_id(order_id) || p.id == core::ship_line_id(order_id)
}

fn work(c: &rusqlite::Connection, buy_id: &str, link: Option<(&str, Kind)>, unlink: Option<&str>) -> Result<Worked, String> {
    let b = buy(c, buy_id)?;
    let ords = orders(c, buy_id);
    let mut deal_of_order = BTreeMap::new();
    for o in &ords {
        if let Some(d) = deal_of(c, &o.invoice_id) {
            deal_of_order.insert(o.id.clone(), d);
        }
    }
    let owned = owned_allocs(c, &b.id);
    let owned_ids: BTreeSet<String> = owned.iter().map(|a| a.id.clone()).collect();
    let mut kinds: BTreeMap<String, Kind> = BTreeMap::new();
    for a in &owned {
        kinds.entry(a.txn_id.clone()).or_insert(kind_of(a));
    }
    if let Some((t, k)) = link {
        if let Some(have) = kinds.get(t) {
            if *have != k {
                return Err(match have {
                    Kind::Goods => "That bank row already pays the goods on this buy. Take it off first to use it for the shipping in.",
                    Kind::Ship => "That bank row already pays the shipping in on this buy. Take it off first to use it for the goods.",
                }
                .into());
            }
        }
        kinds.insert(t.to_string(), k);
    }
    if let Some(t) = unlink {
        kinds.remove(t);
    }
    let mut rows = BTreeMap::new();
    for (t, k) in &kinds {
        if let Some(info) = txn_info(c, t, &owned_ids) {
            rows.insert(t.clone(), (*k, info));
        }
    }
    let live: Vec<&OrderRow> = ords.iter().filter(|o| !o.undone && deal_of_order.contains_key(&o.id)).collect();
    let trucks = trucks_of(c, &b.id);
    let tc = truck_cost_of(&trucks);
    let t = totals_of(&b, &tc);
    let ins: Vec<core::OrderIn> = live.iter().map(|o| core::OrderIn { id: o.id.clone(), count: o.count, goods_typed: o.goods_typed, own_cost: o.own_cost }).collect();
    // R-551: a row a carrier was paid with books no more for the buy than its trucks were paid from it, so the rest of a
    // shared charge stays free for whatever else it paid. A row tied on the buy itself (before it had trucks) keeps its room.
    let tied = |txn: &str| -> Option<f64> {
        let on: Vec<&TruckFull> = trucks.iter().filter(|t| t.truck_in().live() && t.bank_txn_id == txn).collect();
        if on.is_empty() {
            None
        } else {
            Some(core::total(on.iter().map(|t| t.paid.unwrap_or(0.0).max(0.0))))
        }
    };
    let rins: Vec<core::RowIn> = rows
        .iter()
        .map(|(id, (k, i))| {
            let room = core::r2(i.amount - i.others);
            let room = match tied(id) {
                Some(paid) => core::r2(room.min(paid)),
                None => room,
            };
            core::RowIn { txn_id: id.clone(), kind: *k, room, posted_at: i.posted_at.clone() }
        })
        .collect();
    let plan = core::plan(&t, &ins, &rins);
    let mut wants = Vec::new();
    for p in &plan.orders {
        let Some(d) = deal_of_order.get(&p.id) else { continue };
        for s in &p.goods_slices {
            wants.push(Want { deal: d.clone(), txn_id: s.txn_id.clone(), role: "supplier_payment", amount: s.amount, note: core::goods_note(&b.name) });
        }
        for s in &p.ship_slices {
            wants.push(Want { deal: d.clone(), txn_id: s.txn_id.clone(), role: "fee", amount: s.amount, note: core::ship_note(&b.name) });
        }
    }
    for h in &plan.held {
        wants.push(Want { deal: b.id.clone(), txn_id: h.txn_id.clone(), role: "adjustment", amount: h.amount, note: core::held_note(&b.name, h.kind) });
    }
    let mut lines = BTreeMap::new();
    for o in &ords {
        let Some(d) = deal_of_order.get(&o.id) else { continue };
        let (sp, stage): (String, String) = c
            .query_row("SELECT COALESCE(supplier_payments_json,'[]'), COALESCE(stage,'') FROM deal_flows WHERE id=?1", [d], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or_else(|_| ("[]".into(), String::new()));
        let now_lines: Vec<SupplierPayment> = serde_json::from_str(&sp).unwrap_or_default();
        let want_lines = plan.orders.iter().find(|p| p.id == o.id).map(|p| wanted_lines(&b, p)).unwrap_or_default();
        let _ = stage;
        lines.insert(d.clone(), (want_lines, now_lines, o.id.clone()));
    }
    Ok(Worked { b, ords, deal_of_order, owned, rows, t, trucks, tc, plan, wants, lines })
}

fn line(id: String, amount: f64, count: f64, paid: bool, paid_at: &str, category: &str, supplier: (&str, Option<String>), note: String) -> SupplierPayment {
    SupplierPayment {
        id,
        supplier_name: supplier.0.to_string(),
        supplier_id: supplier.1,
        amount,
        original_amount: Some(amount),
        price_changed: false,
        quantity: if count > 0.0 { Some(count) } else { None },
        unit_price: if count > 0.0 { Some(core::r2(amount / count)) } else { None },
        method: None,
        notes: Some(note),
        paid,
        paid_at: if paid && !paid_at.is_empty() { Some(paid_at.to_string()) } else { None },
        category: Some(category.to_string()),
        kept: false,
        supplier_billed: false,
        split: None,
    }
}

fn wanted_lines(b: &BuyRow, p: &core::OrderPlan) -> Vec<SupplierPayment> {
    let mut v = Vec::new();
    if p.own_cost {
        return v;
    }
    let supplier_id = if b.supplier_id.is_empty() { None } else { Some(b.supplier_id.clone()) };
    if p.goods > core::CENT {
        v.push(line(core::goods_line_id(&p.id), p.goods, p.count, p.goods_paid, &p.goods_paid_at, "supplier", (&b.supplier_name, supplier_id), core::goods_note(&b.name)));
    }
    // A shipping share a payment covers is counted by its `fee` booking, never by a line too.
    if p.ship > core::CENT && !p.ship_paid {
        v.push(line(core::ship_line_id(&p.id), p.ship, p.count, false, "", "other", ("Shipping in", None), core::ship_note(&b.name)));
    }
    v
}

fn same_line(a: &SupplierPayment, b: &SupplierPayment) -> bool {
    (a.amount - b.amount).abs() <= core::CENT
        && a.paid == b.paid
        && a.paid_at == b.paid_at
        && a.notes == b.notes
        && a.supplier_name == b.supplier_name
        && a.supplier_id == b.supplier_id
        && a.category == b.category
        && a.quantity == b.quantity
}

fn merged(want: &[SupplierPayment], now_lines: &[SupplierPayment], order_id: &str) -> Option<Vec<SupplierPayment>> {
    let ours_now: Vec<&SupplierPayment> = now_lines.iter().filter(|p| is_ours(p, order_id)).collect();
    let unchanged = ours_now.len() == want.len() && want.iter().all(|w| ours_now.iter().any(|n| n.id == w.id && same_line(n, w)));
    if unchanged {
        return None;
    }
    let mut out: Vec<SupplierPayment> = Vec::new();
    for p in now_lines {
        if !is_ours(p, order_id) {
            out.push(p.clone());
        } else if let Some(w) = want.iter().find(|w| w.id == p.id) {
            out.push(w.clone());
        }
    }
    for w in want {
        if !out.iter().any(|p| p.id == w.id) {
            out.push(w.clone());
        }
    }
    Some(out)
}

fn in_step(w: &Worked) -> bool {
    let mut owned: BTreeMap<(String, String, String), f64> = BTreeMap::new();
    for a in &w.owned {
        *owned.entry((a.deal.clone(), a.txn_id.clone(), a.role.clone())).or_default() += a.amount;
    }
    let mut wanted: BTreeMap<(String, String, String), f64> = BTreeMap::new();
    for x in &w.wants {
        *wanted.entry((x.deal.clone(), x.txn_id.clone(), x.role.to_string())).or_default() += x.amount;
    }
    let bank_ok = owned.len() == wanted.len() && wanted.iter().all(|(k, v)| owned.get(k).map_or(false, |o| (o - v).abs() <= core::CENT));
    bank_ok && w.lines.values().all(|(want, now_lines, oid)| merged(want, now_lines, oid).is_none())
}

/// Write the plan: deals for orders that have none, the bank bookings (when this person may book
/// bank money), then each deal's lines, then re-derive every completed deal that changed.
fn apply(buy_id: &str, link: Option<(&str, Kind)>, unlink: Option<&str>) -> Result<(), String> {
    let invoices: Vec<String> = orders(&*conn()?, buy_id).into_iter().filter(|o| !o.undone).map(|o| o.invoice_id).collect();
    for inv in invoices {
        if let Err(e) = crate::commands::get_or_create_deal_flow_for_invoice(&inv) {
            tracing::warn!("R-488 buy {buy_id}: no deal for invoice {inv}: {e}");
        }
    }
    let w = work(&*conn()?, buy_id, link, unlink)?;
    let book_bank = crate::employees::session_can_book_bank();
    let mut touched: BTreeSet<String> = BTreeSet::new();

    if book_bank {
        // Match what is there to what is wanted by (deal, row, role); shrink and remove first,
        // grow and create after, so no row is ever booked past its amount on the way.
        let mut pool_: Vec<Alloc> = w.owned.clone();
        let mut moves: Vec<(Option<Alloc>, Option<Want>)> = Vec::new();
        for x in &w.wants {
            if let Some(i) = pool_.iter().position(|a| a.deal == x.deal && a.txn_id == x.txn_id && a.role == x.role) {
                moves.push((Some(pool_.remove(i)), Some(x.clone())));
            } else {
                moves.push((None, Some(x.clone())));
            }
        }
        for a in pool_ {
            moves.push((Some(a), None));
        }
        for (have, want) in &moves {
            match (have, want) {
                (Some(a), None) => {
                    alloc_remove(&a.id)?;
                    touched.insert(a.deal.clone());
                }
                (Some(a), Some(x)) if x.amount < a.amount - core::CENT => {
                    alloc_resize(a, x.amount, &x.note)?;
                    touched.insert(a.deal.clone());
                }
                _ => {}
            }
        }
        let t = now();
        let org = crate::employees::session_org_id();
        let by = crate::employees::session_actor().map(|(s, _)| s).unwrap_or_default();
        for (have, want) in &moves {
            match (have, want) {
                (Some(a), Some(x)) if x.amount > a.amount + core::CENT || ((x.amount - a.amount).abs() <= core::CENT && x.note != a.note) => {
                    alloc_resize(a, x.amount, &x.note)?;
                    touched.insert(a.deal.clone());
                }
                (None, Some(x)) => {
                    let a = Alloc {
                        id: core::alloc_id(&w.b.id, &x.deal, &x.txn_id, x.role),
                        org_id: org.clone(),
                        txn_id: x.txn_id.clone(),
                        deal: x.deal.clone(),
                        amount: x.amount,
                        role: x.role.to_string(),
                        note: x.note.clone(),
                        created_by: by.clone(),
                        created_at: t.clone(),
                    };
                    alloc_create(&a)?;
                    touched.insert(a.deal.clone());
                }
                _ => {}
            }
        }
    }

    for (deal, (want, now_lines, oid)) in &w.lines {
        if let Some(next) = merged(want, now_lines, oid) {
            let invoice_id: String = conn()?.query_row("SELECT COALESCE(invoice_id,'') FROM deal_flows WHERE id=?1", [deal], |r| r.get(0)).unwrap_or_default();
            crate::commands::write_sp(deal, &next, &invoice_id)?;
            touched.insert(deal.clone());
        }
    }

    for d in touched {
        if d == w.b.id {
            continue;
        }
        if let Ok(df) = crate::commands::read_df(&d) {
            if df.stage == "complete" {
                if let Err(e) = crate::commands::recalc_completed_deal_flow(&d, df.gross_revenue, &df.supplier_payments) {
                    tracing::warn!("R-488 buy {buy_id}: deal {d} not re-derived: {e}");
                }
            }
        }
    }
    crate::netsync::push_now();
    Ok(())
}

/// R-551: each live order of a buy with the deal it lands on and its share of his markup on the buy's trucks, worked out
/// exactly as `work` builds it (the buy's totals and every live order, in order, since an order's share depends on those
/// taken before it). Empty when the trucks carry no markup for the buy to count (the logistics pay rule is not paying, or none
/// is on them). Twin of the server's `markup_shares`.
fn markup_shares(c: &rusqlite::Connection, b: &BuyRow) -> Vec<(String, f64)> {
    let tc = truck_cost_of(&trucks_of(c, &b.id));
    if tc.markup <= core::CENT {
        return Vec::new();
    }
    let ords = orders(c, &b.id);
    let live: Vec<(&OrderRow, Option<String>)> = ords.iter().filter(|o| !o.undone).map(|o| (o, deal_of(c, &o.invoice_id))).filter(|(_, d)| d.is_some()).collect();
    let ins: Vec<core::OrderIn> = live.iter().map(|(o, _)| core::OrderIn { id: o.id.clone(), count: o.count, goods_typed: o.goods_typed, own_cost: o.own_cost }).collect();
    let plan = core::plan(&totals_of(b, &tc), &ins, &[]);
    live.iter().zip(plan.orders.iter()).filter_map(|((_, d), p)| d.clone().map(|d| (d, p.markup))).collect()
}

/// R-551: his markup on the trucks that brought in the stock the orders of one deal took, summed. Feeds the cut taken off the
/// deal's owner split (`freight::cut_as`). 0 while the logistics pay rule is not paying.
pub(crate) fn markup_on_deal(c: &rusqlite::Connection, deal: &str) -> f64 {
    let invoice: Option<String> = c
        .query_row("SELECT COALESCE(invoice_id,'') FROM deal_flows WHERE id=?1", [deal], |r| r.get(0))
        .ok()
        .filter(|i: &String| !i.is_empty());
    let Some(invoice) = invoice else { return 0.0 };
    let buy_ids: Vec<String> = c
        .prepare(
            "SELECT DISTINCT o.buy_id FROM warehouse_buy_orders o JOIN warehouse_buys b ON b.id=o.buy_id \
             WHERE o.invoice_id=?1 AND COALESCE(o.undone,0)=0 AND COALESCE(b.archived,0)=0",
        )
        .and_then(|mut st| st.query_map([&invoice], |r| r.get::<_, String>(0)).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    let mut sum = 0.0;
    for id in buy_ids {
        let Ok(b) = buy(c, &id) else { continue };
        sum += markup_shares(c, &b).into_iter().filter(|(d, _)| d == deal).map(|(_, m)| m).sum::<f64>();
    }
    core::r2(sum)
}

// ---------------------------------------------------------------------------------------
// Reading for the screens

fn order_money(c: &rusqlite::Connection, deal: &str, plan: &core::OrderPlan) -> core::OrderMoney {
    let Ok(df) = crate::commands::read_df(deal) else {
        return core::OrderMoney { id: plan.id.clone(), ..Default::default() };
    };
    let bank_in: f64 = c
        .query_row(
            "SELECT COALESCE(SUM(a.amount),0) FROM bank_allocation a WHERE a.deal_flow_id=?1 AND a.role='buyer_payment' AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)",
            [deal],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let paid_stage = matches!(df.stage.as_str(), "payment_received" | "supplier_paid" | "complete");
    let received = if bank_in > core::CENT { bank_in } else if paid_stage { df.payment_received_amount } else { 0.0 };
    let refunds: f64 = c
        .query_row(
            "SELECT COALESCE(SUM(x.amt),0) FROM ( \
               SELECT r.amount AS amt FROM refunds r WHERE r.deal_flow_id=?1 AND COALESCE(r.bank_txn_id,'')='' \
               UNION ALL SELECT a.amount FROM bank_allocation a WHERE a.deal_flow_id=?1 AND a.role='refund_out' \
                 AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)) x",
            [deal],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let complete = df.stage == "complete";
    let sales = if complete && df.gross_revenue > 0.0 { df.gross_revenue } else { df.invoice_total };
    let deal_cost = if complete { df.total_cost } else { df.projected_cost };
    let ours = if plan.own_cost { 0.0 } else { plan.goods + plan.ship };
    let own_cost: f64 = if plan.own_cost {
        df.supplier_payments.iter().filter(|p| p.category.as_deref().unwrap_or("supplier") == "supplier" && !p.kept).map(|p| p.amount).sum()
    } else {
        0.0
    };
    core::OrderMoney { id: plan.id.clone(), sales, received, other_cost: core::r2((deal_cost - ours - own_cost).max(0.0)), refunds, own_cost }
}

fn detail(c: &rusqlite::Connection, id: &str) -> Result<Value, String> {
    let w = work(c, id, None, None)?;
    let t = w.t.clone();
    let (left, stock_name) = stock_left(c, &w.b);
    let money: Vec<core::OrderMoney> = w.plan.orders.iter().filter_map(|p| w.deal_of_order.get(&p.id).map(|d| order_money(c, d, p))).collect();
    let roll = core::rollup(&t, &w.plan, &money, left);
    let orders_json: Vec<Value> = w
        .ords
        .iter()
        .map(|o| {
            let (number, client, voided): (String, String, bool) = c
                .query_row(
                    "SELECT COALESCE(i.number,''), COALESCE((SELECT name FROM clients cl WHERE cl.id=i.client_id),''), COALESCE(i.voided,0) FROM invoices i WHERE i.id=?1",
                    [&o.invoice_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
                )
                .unwrap_or_default();
            let deal = w.deal_of_order.get(&o.id);
            let stage: String = deal
                .and_then(|d| c.query_row("SELECT COALESCE(stage,'') FROM deal_flows WHERE id=?1", [d], |r| r.get(0)).ok())
                .unwrap_or_default();
            let p = w.plan.orders.iter().find(|p| p.id == o.id);
            let f = roll.orders.iter().find(|f| f.id == o.id);
            json!({
                "id": o.id, "invoice_id": o.invoice_id, "number": number, "client": client, "stage": stage, "voided": voided,
                "count": o.count, "undone": o.undone, "own_cost": o.own_cost, "typed": o.goods_typed.is_some(), "deal_flow_id": deal,
                "goods": p.map(|p| p.goods).unwrap_or(0.0), "ship": p.map(|p| p.ship).unwrap_or(0.0), "markup": p.map(|p| p.markup).unwrap_or(0.0),
                "goods_paid": p.map(|p| p.goods_paid).unwrap_or(false), "ship_paid": p.map(|p| p.ship_paid).unwrap_or(false),
                "past_bought": p.map(|p| p.past_bought).unwrap_or(false),
                "cost": f.map(|f| f.cost).unwrap_or(0.0), "sales": f.map(|f| f.sales).unwrap_or(0.0),
                "received": f.map(|f| f.received).unwrap_or(0.0), "other_cost": f.map(|f| f.other_cost).unwrap_or(0.0),
                "refunds": f.map(|f| f.refunds).unwrap_or(0.0), "made": f.map(|f| f.made).unwrap_or(0.0),
                "created_at": o.created_at,
            })
        })
        .collect();
    let owned_by_txn = |t: &str| -> f64 { w.owned.iter().filter(|a| a.txn_id == t).map(|a| a.amount).sum() };
    let payments: Vec<Value> = w
        .rows
        .iter()
        .map(|(tid, (k, i))| {
            json!({
                "txn_id": tid, "kind": k, "amount": i.amount, "posted_at": i.posted_at, "name": i.name,
                "cash": i.source_format == "manual_cash", "booked_here": core::r2(owned_by_txn(tid)), "booked_elsewhere": core::r2(i.others),
            })
        })
        .collect();
    let missing: Vec<Value> = candidates(c, &w.b, &w.ords)
        .into_iter()
        .map(|m| {
            let number: String = c.query_row("SELECT COALESCE(number,'') FROM invoices WHERE id=?1", [&m.invoice_id], |r| r.get(0)).unwrap_or_default();
            json!({ "invoice_id": m.invoice_id, "number": number, "count": m.count, "own_cost": has_own_cost(c, &m.invoice_id) })
        })
        .collect();
    Ok(json!({
        "buy": {
            "id": w.b.id, "item_id": w.b.item_id, "load_id": w.b.load_id, "stock_name": stock_name, "name": w.b.name,
            "supplier_id": w.b.supplier_id, "supplier_name": w.b.supplier_name, "units_bought": w.b.units,
            "goods_total": w.b.goods, "ship_total": w.t.ship, "ship_typed": w.b.ship, "markup_total": w.t.markup, "notes": w.b.notes,
            "archived": w.b.archived, "on_the_way": w.b.item_id.is_empty() && w.b.load_id.is_empty(),
            "created_at": w.b.created_at, "updated_at": w.b.updated_at,
        },
        "rollup": roll,
        "unit_goods": w.plan.unit_goods, "unit_ship": w.plan.unit_ship, "unit_markup": w.plan.unit_markup,
        "trucks": truck_rows(&w.trucks, &w.tc), "truck_cost": w.tc,
        "orders": orders_json,
        "payments": payments,
        "missing": missing,
        "in_step": in_step(&w),
        "can_book_bank": crate::employees::session_can_book_bank(),
    }))
}

fn summary(c: &rusqlite::Connection, b: &BuyRow) -> Value {
    match detail(c, &b.id) {
        Ok(d) => json!({
            "id": b.id, "name": b.name, "supplier_name": b.supplier_name, "item_id": b.item_id, "load_id": b.load_id,
            "rollup": d["rollup"].clone(),
            "orders": d["orders"].as_array().map(|a| a.iter().filter(|o| !o["undone"].as_bool().unwrap_or(false)).count()).unwrap_or(0),
            "in_step": d["in_step"].clone(), "missing": d["missing"].as_array().map(|a| a.len()).unwrap_or(0),
        }),
        Err(_) => json!({ "id": b.id, "name": b.name }),
    }
}

// ---------------------------------------------------------------------------------------
// Commands

/// Every product and delivery in the warehouse, each with its buy when one is recorded: the
/// Inventory tab in Deal Flow and the In the warehouse section of Inventory read this.
#[tauri::command]
pub async fn list_warehouse_buys() -> Result<Value, String> {
    let c = conn()?;
    let buys: Vec<BuyRow> = {
        let mut st = c.prepare(&format!("SELECT {BUY_COLS} FROM warehouse_buys WHERE COALESCE(archived,0)=0 ORDER BY created_at DESC")).map_err(|e| e.to_string())?;
        let it = st.query_map([], map_buy).map_err(|e| e.to_string())?;
        it.filter_map(|x| x.ok()).collect()
    };
    let mut stock: Vec<Value> = Vec::new();
    {
        let mut st = c
            .prepare("SELECT id, COALESCE(name,''), COALESCE(sections_json,'[]'), COALESCE(box_types_json,'[]'), updated_at FROM warehouse_items WHERE COALESCE(archived,0)=0 ORDER BY name")
            .map_err(|e| e.to_string())?;
        let it = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)))
            .map_err(|e| e.to_string())?;
        let rows: Vec<_> = it.filter_map(|x| x.ok()).collect();
        for (id, name, s, t, up) in rows {
            let b = buys.iter().find(|b| b.item_id == id);
            stock.push(json!({ "kind": "item", "id": id, "name": name, "left": item_units(&s, &t), "unit": "units", "updated_at": up, "buy": b.map(|b| summary(&c, b)) }));
        }
    }
    {
        let mut st = c
            .prepare("SELECT id, COALESCE(name,''), COALESCE(lines_json,'[]'), updated_at FROM warehouse_loads WHERE COALESCE(archived,0)=0 ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;
        let it = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
            .map_err(|e| e.to_string())?;
        let rows: Vec<_> = it.filter_map(|x| x.ok()).collect();
        for (id, name, lines, up) in rows {
            let b = buys.iter().find(|b| b.load_id == id);
            stock.push(json!({ "kind": "load", "id": id, "name": name, "left": load_pairs_left(&c, &id, &lines), "unit": "pairs", "updated_at": up, "buy": b.map(|b| summary(&c, b)) }));
        }
    }
    // R-551: the buys started before their stock is here, newest first (`buys` is read newest first).
    let coming: Vec<Value> = buys
        .iter()
        .filter(|b| b.item_id.is_empty() && b.load_id.is_empty())
        .filter_map(|b| {
            work(&c, &b.id, None, None).ok().map(|w| {
                json!({
                    "id": b.id, "name": b.name, "supplier_id": b.supplier_id, "supplier_name": b.supplier_name,
                    "goods_total": b.goods, "units_bought": b.units, "created_at": b.created_at,
                    "truck_cost": w.tc, "trucks": truck_rows(&w.trucks, &w.tc), "goods_paid": w.plan.goods_paid,
                })
            })
        })
        .collect();
    Ok(json!({ "stock": stock, "coming": coming }))
}

/// The live buy on a product or a delivery, for the invoice form's cost line.
#[tauri::command]
pub async fn warehouse_buy_for(item_id: Option<String>, load_id: Option<String>) -> Result<Value, String> {
    let c = conn()?;
    let Some(b) = buy_for(&c, item_id.as_deref().unwrap_or(""), load_id.as_deref().unwrap_or("")) else { return Ok(json!({ "buy": null })) };
    let units = b.units.max(0.0);
    let sold = core::total(orders(&c, &b.id).iter().filter(|o| !o.undone).map(|o| o.count));
    let tc = truck_cost_of(&trucks_of(&c, &b.id));
    let ship = core::ship_in(b.ship, &tc);
    let (ug, us, um) = if units > 0.0 { (b.goods / units, ship / units, tc.markup / units) } else { (0.0, 0.0, 0.0) };
    Ok(json!({ "buy": { "id": b.id, "name": b.name, "units_bought": b.units, "sold": sold, "unit_goods": ug, "unit_ship": us, "unit_markup": um } }))
}

/// R-552: every live buy a payment can be tied to, with what each leg cost and what is booked on it: Financials' Inventory
/// buy and a sold deal's Link a payment to the buy read this. With a deal, only the buys its invoice took stock from.
#[tauri::command]
pub async fn warehouse_buy_choices(deal_flow_id: Option<String>) -> Result<Value, String> {
    let c = conn()?;
    let ids: Vec<String> = match deal_flow_id.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => {
            let invoice: String = c.query_row("SELECT COALESCE(invoice_id,'') FROM deal_flows WHERE id=?1", [d], |r| r.get(0)).unwrap_or_default();
            if invoice.is_empty() {
                Vec::new()
            } else {
                c.prepare(
                    "SELECT DISTINCT o.buy_id FROM warehouse_buy_orders o JOIN warehouse_buys b ON b.id=o.buy_id                      WHERE o.invoice_id=?1 AND COALESCE(o.undone,0)=0 AND COALESCE(b.archived,0)=0",
                )
                .and_then(|mut st| st.query_map([&invoice], |r| r.get::<_, String>(0)).map(|it| it.filter_map(|x| x.ok()).collect()))
                .unwrap_or_default()
            }
        }
        None => c
            .prepare("SELECT id FROM warehouse_buys WHERE COALESCE(archived,0)=0 ORDER BY created_at DESC")
            .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0)).map(|it| it.filter_map(|x| x.ok()).collect()))
            .unwrap_or_default(),
    };
    let out: Vec<Value> = ids
        .iter()
        .filter_map(|id| work(&c, id, None, None).ok())
        .map(|w| {
            let (_, stock_name) = stock_left(&c, &w.b);
            json!({
                "id": w.b.id, "name": w.b.name, "supplier_name": w.b.supplier_name, "stock_name": stock_name,
                "on_the_way": w.b.item_id.is_empty() && w.b.load_id.is_empty(), "trucks": w.tc.live,
                "goods_total": w.t.goods, "goods_paid": w.plan.goods_paid, "ship_total": w.t.ship, "ship_paid": w.plan.ship_paid,
            })
        })
        .collect();
    Ok(json!(out))
}

#[tauri::command]
pub async fn get_warehouse_buy(id: String) -> Result<Value, String> {
    detail(&*conn()?, &id)
}

#[derive(Deserialize)]
pub struct BuyInput {
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub load_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub supplier_id: Option<String>,
    #[serde(default)]
    pub supplier_name: Option<String>,
    #[serde(default)]
    pub units_bought: Option<f64>,
    #[serde(default)]
    pub goods_total: Option<f64>,
    #[serde(default)]
    pub ship_total: Option<f64>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// `allow_unknown_units`: a buy still on the way (no stock yet) may leave how many were bought as 0, which the stock fills in
/// once it is attached.
fn check_money(units: f64, goods: f64, ship: f64, allow_unknown_units: bool) -> Result<(), String> {
    if !units.is_finite() || units < 0.0 || (units == 0.0 && !allow_unknown_units) {
        return Err("Enter how many were bought.".into());
    }
    if !(goods >= 0.0) || !goods.is_finite() || !(ship >= 0.0) || !ship.is_finite() {
        return Err("Enter what was paid, as a number.".into());
    }
    Ok(())
}

fn new_order(buy_id: &str, invoice_id: &str, count: f64, goods_typed: Option<f64>, own_cost: bool, at: &str) -> Result<String, String> {
    let oid = core::order_id(invoice_id, buy_id);
    let undone: Option<bool> = conn()?
        .query_row("SELECT COALESCE(undone,0) FROM warehouse_buy_orders WHERE id=?1", [&oid], |r| Ok(r.get::<_, i64>(0)? != 0))
        .ok();
    match undone {
        Some(false) => return Ok(oid),
        // Put back, then the stock went out on the same invoice again: the order is back.
        Some(true) => {
            let mut cols = Map::new();
            cols.insert("count".into(), json!(count));
            cols.insert("goods_typed".into(), goods_typed.map(|g| json!(core::r2(g))).unwrap_or(Value::Null));
            cols.insert("undone".into(), json!(0));
            cols.insert("undone_at".into(), json!(""));
            cols.insert("updated_at".into(), json!(now()));
            put(ORDERS, &oid, cols, false)?;
            return Ok(oid);
        }
        None => {}
    }
    let t = now();
    let mut cols = Map::new();
    cols.insert("buy_id".into(), json!(buy_id));
    cols.insert("invoice_id".into(), json!(invoice_id));
    cols.insert("count".into(), json!(count));
    cols.insert("goods_typed".into(), goods_typed.map(|g| json!(core::r2(g))).unwrap_or(Value::Null));
    cols.insert("own_cost".into(), json!(own_cost as i64));
    cols.insert("undone".into(), json!(0));
    cols.insert("undone_at".into(), json!(""));
    cols.insert("created_at".into(), json!(if at.is_empty() { t.clone() } else { at.to_string() }));
    cols.insert("updated_at".into(), json!(t));
    put(ORDERS, &oid, cols, true)?;
    Ok(oid)
}

/// Record a buy on a product or a delivery. The orders already taken from it come with it,
/// except that a deal whose supplier cost was typed by hand keeps that cost. R-551: with neither a product nor a delivery it
/// is a buy still on the way: it needs a name, and how many were bought may be left 0 until its stock is attached.
#[tauri::command]
pub async fn create_warehouse_buy(input: BuyInput) -> Result<Value, String> {
    let (item_id, load_id) = (input.item_id.unwrap_or_default(), input.load_id.unwrap_or_default());
    let (units, goods, ship) = (input.units_bought.unwrap_or(0.0), core::r2(input.goods_total.unwrap_or(0.0)), core::r2(input.ship_total.unwrap_or(0.0)));
    if !item_id.is_empty() && !load_id.is_empty() {
        return Err("Choose the product or the delivery this buy is for.".into());
    }
    let on_the_way = item_id.is_empty() && load_id.is_empty();
    if on_the_way && input.name.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("Say what it is.".into());
    }
    check_money(units, goods, ship, on_the_way)?;
    if on_the_way {
        let id = format!("buy_{}", uuid::Uuid::new_v4().simple());
        let t = now();
        let by = crate::employees::session_actor().map(|(s, _)| s).unwrap_or_default();
        let mut cols = Map::new();
        cols.insert("item_id".into(), json!(""));
        cols.insert("load_id".into(), json!(""));
        cols.insert("name".into(), json!(input.name.as_deref().map(str::trim).unwrap_or("")));
        cols.insert("supplier_id".into(), json!(input.supplier_id.unwrap_or_default()));
        cols.insert("supplier_name".into(), json!(input.supplier_name.unwrap_or_default().trim()));
        cols.insert("units_bought".into(), json!(units));
        cols.insert("goods_total".into(), json!(goods));
        cols.insert("ship_total".into(), json!(ship));
        cols.insert("notes".into(), json!(input.notes.unwrap_or_default()));
        cols.insert("archived".into(), json!(0));
        cols.insert("created_by".into(), json!(by));
        cols.insert("created_at".into(), json!(t));
        cols.insert("updated_at".into(), json!(t));
        put(BUYS, &id, cols, true)?;
        apply(&id, None, None)?;
        return detail(&*conn()?, &id);
    }
    let (stock_name, cands) = {
        let c = conn()?;
        let name: Option<String> = if !item_id.is_empty() {
            c.query_row("SELECT name FROM warehouse_items WHERE id=?1", [&item_id], |r| r.get(0)).ok()
        } else {
            c.query_row("SELECT name FROM warehouse_loads WHERE id=?1", [&load_id], |r| r.get(0)).ok()
        };
        let Some(name) = name else { return Err("That stock is no longer in the warehouse.".into()) };
        if buy_for(&c, &item_id, &load_id).is_some() {
            return Err("This stock already has its buy. Change that one instead.".into());
        }
        let probe = BuyRow {
            id: String::new(), item_id: item_id.clone(), load_id: load_id.clone(), name: String::new(), supplier_id: String::new(),
            supplier_name: String::new(), units, goods, ship, notes: String::new(), archived: false, created_at: String::new(), updated_at: String::new(),
        };
        let cs: Vec<(Candidate, bool)> = candidates(&c, &probe, &[]).into_iter().map(|m| { let own = has_own_cost(&c, &m.invoice_id); (m, own) }).collect();
        (name, cs)
    };
    let id = format!("buy_{}", uuid::Uuid::new_v4().simple());
    let t = now();
    let by = crate::employees::session_actor().map(|(s, _)| s).unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("item_id".into(), json!(item_id));
    cols.insert("load_id".into(), json!(load_id));
    cols.insert("name".into(), json!(input.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&stock_name)));
    cols.insert("supplier_id".into(), json!(input.supplier_id.unwrap_or_default()));
    cols.insert("supplier_name".into(), json!(input.supplier_name.unwrap_or_default().trim()));
    cols.insert("units_bought".into(), json!(units));
    cols.insert("goods_total".into(), json!(goods));
    cols.insert("ship_total".into(), json!(ship));
    cols.insert("notes".into(), json!(input.notes.unwrap_or_default()));
    cols.insert("archived".into(), json!(0));
    cols.insert("created_by".into(), json!(by));
    cols.insert("created_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    put(BUYS, &id, cols, true)?;
    for (m, own) in cands {
        new_order(&id, &m.invoice_id, m.count, None, own, &m.at)?;
    }
    apply(&id, None, None)?;
    detail(&*conn()?, &id)
}

#[tauri::command]
pub async fn update_warehouse_buy(id: String, input: BuyInput) -> Result<Value, String> {
    let (b, live_trucks) = {
        let c = conn()?;
        let b = buy(&c, &id)?;
        let live = trucks_of(&c, &id).iter().filter(|t| t.truck_in().live()).count();
        (b, live)
    };
    let units = input.units_bought.unwrap_or(b.units);
    let goods = core::r2(input.goods_total.unwrap_or(b.goods));
    let ship = core::r2(input.ship_total.unwrap_or(b.ship));
    // R-551: a buy with no stock yet may leave how many were bought at 0, and once it has stock it must be more.
    check_money(units, goods, ship, b.item_id.is_empty() && b.load_id.is_empty())?;
    // R-551: while the buy has a truck its shipping in is what the trucks cost, so a different typed figure has no effect.
    if live_trucks > 0 && (ship - b.ship).abs() > core::CENT {
        return Err("This buy's shipping in comes from its trucks.".into());
    }
    let mut cols = Map::new();
    if let Some(n) = input.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cols.insert("name".into(), json!(n));
    }
    // The supplier's id follows its name: kept while the name is unchanged, cleared when another name
    // is typed without one.
    if let Some(s) = input.supplier_name.as_deref().map(str::trim) {
        if s != b.supplier_name {
            cols.insert("supplier_name".into(), json!(s));
            cols.insert("supplier_id".into(), json!(input.supplier_id.clone().unwrap_or_default()));
        } else if let Some(id) = input.supplier_id.as_deref().filter(|i| !i.is_empty()) {
            cols.insert("supplier_id".into(), json!(id));
        }
    }
    cols.insert("units_bought".into(), json!(units));
    cols.insert("goods_total".into(), json!(goods));
    cols.insert("ship_total".into(), json!(ship));
    if let Some(n) = input.notes {
        cols.insert("notes".into(), json!(n));
    }
    cols.insert("updated_at".into(), json!(now()));
    put(BUYS, &id, cols, false)?;
    apply(&id, None, None)?;
    detail(&*conn()?, &id)
}

/// R-551: a buy still on the way gets its stock, the product or the delivery its manifest made. Exactly one of `item_id` and
/// `load_id`. The stock must be here, not removed and not already carry a buy. When how many were bought is still 0 it becomes
/// the stock's count (a delivery: the pairs its manifest expects, a product: the units on the shelf). Orders already taken from
/// that stock come onto the buy as `create_warehouse_buy` brings them.
#[tauri::command]
pub async fn attach_warehouse_buy(id: String, item_id: Option<String>, load_id: Option<String>) -> Result<Value, String> {
    let (item_id, load_id) = (item_id.unwrap_or_default().trim().to_string(), load_id.unwrap_or_default().trim().to_string());
    if item_id.is_empty() == load_id.is_empty() {
        return Err("Choose the product or the delivery this buy is for.".into());
    }
    const GONE: &str = "That stock is no longer in the warehouse.";
    let (units, cands) = {
        let c = conn()?;
        let b = buy(&c, &id)?;
        if b.archived {
            return Err("That buy was removed.".into());
        }
        if !b.item_id.is_empty() || !b.load_id.is_empty() {
            return Err("This buy is already on its stock.".into());
        }
        let count = if !item_id.is_empty() {
            let row: Option<(String, String, i64)> = c
                .query_row(
                    "SELECT COALESCE(sections_json,'[]'), COALESCE(box_types_json,'[]'), COALESCE(archived,0) FROM warehouse_items WHERE id=?1",
                    [&item_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            match row {
                Some((sections, types, 0)) => item_units(&sections, &types),
                _ => return Err(GONE.into()),
            }
        } else {
            let row: Option<(String, i64)> = c
                .query_row("SELECT COALESCE(lines_json,'[]'), COALESCE(archived,0) FROM warehouse_loads WHERE id=?1", [&load_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .ok();
            match row {
                Some((lines, 0)) => {
                    let lines: Vec<crate::case_core::LoadLine> = serde_json::from_str(&lines).unwrap_or_default();
                    lines.iter().map(|l| l.expected()).sum::<i64>() as f64
                }
                _ => return Err(GONE.into()),
            }
        };
        if buy_for(&c, &item_id, &load_id).is_some() {
            return Err("This stock already has its buy. Change that one instead.".into());
        }
        let units = if b.units > 0.0 { b.units } else { count };
        if !(units > 0.0) {
            return Err("Enter how many were bought on the buy first.".into());
        }
        let probe = BuyRow { item_id: item_id.clone(), load_id: load_id.clone(), units, ..b };
        let cands: Vec<(Candidate, bool)> = candidates(&c, &probe, &[]).into_iter().map(|m| { let own = has_own_cost(&c, &m.invoice_id); (m, own) }).collect();
        (units, cands)
    };
    let mut cols = Map::new();
    cols.insert("item_id".into(), json!(item_id));
    cols.insert("load_id".into(), json!(load_id));
    cols.insert("units_bought".into(), json!(units));
    cols.insert("updated_at".into(), json!(now()));
    put(BUYS, &id, cols, false)?;
    for (m, own) in cands {
        new_order(&id, &m.invoice_id, m.count, None, own, &m.at)?;
    }
    apply(&id, None, None)?;
    detail(&*conn()?, &id)
}

/// Remove a buy recorded by mistake: only while nothing hangs on it. Archived, never deleted.
#[tauri::command]
pub async fn archive_warehouse_buy(id: String) -> Result<(), String> {
    {
        let w = work(&*conn()?, &id, None, None)?;
        // R-551: its trucks are cancelled or removed in Logistics first (a removed buy would orphan them).
        if w.tc.live > 0 {
            return Err("Cancel its trucks in Logistics first.".into());
        }
        if w.ords.iter().any(|o| !o.undone) || !w.owned.is_empty() {
            return Err("This buy has orders or a payment on it. Put the orders back and take the payments off first.".into());
        }
    }
    let t = now();
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(1));
    cols.insert("archived_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    put(BUYS, &id, cols, false)
}

/// Tie a bank row (or a cash payment) to the buy, for the goods or the shipping in.
#[tauri::command]
pub async fn pay_warehouse_buy(
    id: String,
    kind: Kind,
    txn_id: Option<String>,
    cash_amount: Option<f64>,
    cash_date: Option<String>,
    take: Option<core::Take>,
) -> Result<Value, String> {
    if !crate::employees::session_can_book_bank() {
        return Err(NEEDS_FINANCIALS.into());
    }
    let (b, live_trucks) = {
        let c = conn()?;
        let b = buy(&c, &id)?;
        let live = trucks_of(&c, &id).iter().filter(|t| t.truck_in().live()).count();
        (b, live)
    };
    // R-551: with trucks the shipping in is paid per truck, in Pay carriers or on the truck.
    if kind == Kind::Ship && live_trucks > 0 {
        return Err("Tie the carrier payment to its truck.".into());
    }
    // R-552: what the payment has free, worked out before anything is written, so a refusal leaves no cash row behind.
    let txn_id = txn_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let room = match (&txn_id, cash_amount) {
        (Some(t), _) => {
            let c = conn()?;
            let (dir, amount): (String, f64) = c
                .query_row("SELECT COALESCE(direction,''), COALESCE(amount,0) FROM bank_txn WHERE id=?1", [t], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| "That bank row is no longer here.".to_string())?;
            if dir != "out" {
                return Err("Choose money that went out, not money that came in.".into());
            }
            if let Some(a) = owned_allocs(&c, &id).into_iter().find(|a| &a.txn_id == t) {
                return Err(match kind_of(&a) {
                    k if k == kind => core::PAY_ALREADY_HERE,
                    Kind::Goods => "That bank row already pays the goods on this buy. Take it off first to use it for the shipping in.",
                    Kind::Ship => "That bank row already pays the shipping in on this buy. Take it off first to use it for the goods.",
                }
                .into());
            }
            core::r2(amount - core::total(allocs_where(&c, "a.bank_txn_id=?1", &[t]).iter().map(|a| a.amount)))
        }
        (None, Some(a)) if a > 0.0 && a.is_finite() => core::r2(a),
        _ => return Err("Choose the bank row that paid it, or enter the cash paid.".into()),
    };
    // R-552: it books in full or says why. No cost typed, or Book all of it: what the buy cost rises to what was paid.
    let w = work(&*conn()?, &id, None, None)?;
    let (total, paid) = match kind {
        Kind::Goods => (w.t.goods, w.plan.goods_paid),
        Kind::Ship => (w.t.ship, w.plan.ship_paid),
    };
    let (_, raise) = core::pay_take(total, paid, room, take)?;
    let txn = match (txn_id, cash_amount) {
        (Some(t), _) => t,
        (None, Some(a)) => {
            let desc = match kind {
                Kind::Goods => format!("Cash paid for {}", b.name),
                Kind::Ship => format!("Cash paid for shipping in, {}", b.name),
            };
            let cp = if kind == Kind::Goods { Some(b.supplier_name.clone()) } else { None };
            crate::commands::add_cash_transaction(core::r2(a), "out".into(), cash_date.unwrap_or_default(), cp, Some(desc)).await?
        }
        _ => return Err("Choose the bank row that paid it, or enter the cash paid.".into()),
    };
    if let Some(cost) = raise {
        let mut cols = Map::new();
        cols.insert(if kind == Kind::Goods { "goods_total" } else { "ship_total" }.into(), json!(cost));
        cols.insert("updated_at".into(), json!(now()));
        put(BUYS, &id, cols, false)?;
    }
    apply(&id, Some((&txn, kind)), None)?;
    detail(&*conn()?, &id)
}

/// Take a bank row off the buy: every booking the buy made on it goes.
#[tauri::command]
pub async fn unpay_warehouse_buy(id: String, txn_id: String) -> Result<Value, String> {
    take_off(&id, &txn_id)?;
    detail(&*conn()?, &id)
}

/// Take a bank row off the buy, on the buy or from Financials (R-552: a booking a buy made is one slice of a payment it
/// spreads over its orders, so Financials takes the whole payment off, never the slice alone).
pub(crate) fn take_off(id: &str, txn_id: &str) -> Result<(), String> {
    if !crate::employees::session_can_book_bank() {
        return Err(NEEDS_FINANCIALS.into());
    }
    // R-551: a bank row a truck's carrier was paid with is taken off that truck (Pay carriers), which untangles both.
    let tied = trucks_of(&*conn()?, id).iter().any(|t| !t.archived && !t.bank_txn_id.is_empty() && t.bank_txn_id == txn_id);
    if tied {
        return Err("That payment is tied to a truck. Take it off the truck in Pay carriers.".into());
    }
    apply(id, None, Some(txn_id))
}

/// R-552: the live buy a bank booking was made by, and the row it books, for Financials' Remove. None for any other booking.
pub(crate) fn booking_of_buy(alloc_id: &str) -> Option<(String, String)> {
    let buy_id = core::buy_of_alloc(alloc_id)?;
    let c = conn().ok()?;
    let b = buy(&c, buy_id).ok().filter(|b| !b.archived)?;
    let txn: String = c.query_row("SELECT COALESCE(bank_txn_id,'') FROM bank_allocation WHERE id=?1", [alloc_id], |r| r.get(0)).ok()?;
    (!txn.is_empty()).then_some((b.id, txn))
}

/// An invoice took stock from the buy: record the order and write its cost. Made by the invoice
/// form right after the stock leaves; the same invoice twice is one order.
#[tauri::command]
pub async fn add_warehouse_buy_order(id: String, invoice_id: String, count: f64, goods_typed: Option<f64>) -> Result<String, String> {
    if !(count > 0.0) || !count.is_finite() {
        return Err("Nothing was taken for this order.".into());
    }
    {
        let c = conn()?;
        if buy(&c, &id)?.archived {
            return Err("That buy was removed.".into());
        }
        if !live_invoice(&c, &invoice_id) {
            return Err("That invoice is no longer here.".into());
        }
    }
    let oid = new_order(&id, &invoice_id, count, goods_typed.filter(|g| g.is_finite() && *g >= 0.0), false, "")?;
    apply(&id, None, None)?;
    Ok(oid)
}

/// Type an order's cost (`goods_typed`), go back to the worked-out cost (`clear_typed`), or take
/// the order off the buy (`undone`).
#[tauri::command]
pub async fn update_warehouse_buy_order(id: String, order_id: String, goods_typed: Option<f64>, clear_typed: Option<bool>, undone: Option<bool>) -> Result<Value, String> {
    if conn()?.query_row("SELECT 1 FROM warehouse_buy_orders WHERE id=?1 AND buy_id=?2", [&order_id, &id], |_| Ok(())).is_err() {
        return Err("That order is no longer on this buy.".into());
    }
    let t = now();
    let mut cols = Map::new();
    if clear_typed.unwrap_or(false) {
        cols.insert("goods_typed".into(), Value::Null);
    } else if let Some(g) = goods_typed {
        if !(g.is_finite() && g >= 0.0) {
            return Err("Enter the cost as a number.".into());
        }
        cols.insert("goods_typed".into(), json!(core::r2(g)));
    }
    if let Some(u) = undone {
        cols.insert("undone".into(), json!(u as i64));
        cols.insert("undone_at".into(), json!(if u { t.clone() } else { String::new() }));
    }
    cols.insert("updated_at".into(), json!(t));
    put(ORDERS, &order_id, cols, false)?;
    apply(&id, None, None)?;
    detail(&*conn()?, &id)
}

/// Add every order already taken from the stock that the buy does not have yet.
#[tauri::command]
pub async fn add_missing_warehouse_buy_orders(id: String) -> Result<Value, String> {
    let cands = {
        let c = conn()?;
        let b = buy(&c, &id)?;
        let have = orders(&c, &id);
        candidates(&c, &b, &have).into_iter().map(|m| { let own = has_own_cost(&c, &m.invoice_id); (m, own) }).collect::<Vec<_>>()
    };
    for (m, own) in cands {
        new_order(&id, &m.invoice_id, m.count, None, own, &m.at)?;
    }
    apply(&id, None, None)?;
    detail(&*conn()?, &id)
}

/// Write the buy's costs and bookings again, when the screen says they are out of step.
#[tauri::command]
pub async fn apply_warehouse_buy(id: String) -> Result<Value, String> {
    apply(&id, None, None)?;
    detail(&*conn()?, &id)
}

/// Stock went back from an order (Put back on a product's History or a delivery's sold list): the
/// order comes off the buy and its share goes back. Logged, never failing the put back itself.
pub(crate) fn stock_put_back(item_id: &str, load_id: &str, invoice_id: &str) {
    if invoice_id.is_empty() {
        return;
    }
    let found = conn().ok().and_then(|c| {
        buy_for(&c, item_id, load_id).map(|b| {
            let oid = core::order_id(invoice_id, &b.id);
            let live = c.query_row("SELECT 1 FROM warehouse_buy_orders WHERE id=?1 AND COALESCE(undone,0)=0", [&oid], |_| Ok(())).is_ok();
            (b.id, oid, live)
        })
    });
    let Some((buy_id, oid, true)) = found else { return };
    let t = now();
    let mut cols = Map::new();
    cols.insert("undone".into(), json!(1));
    cols.insert("undone_at".into(), json!(t));
    cols.insert("updated_at".into(), json!(t));
    if let Err(e) = put(ORDERS, &oid, cols, false).and_then(|_| apply(&buy_id, None, None)) {
        tracing::warn!("R-488 put back on buy {buy_id}, order {oid}: {e}");
    }
}

/// A product's move was put back: the invoice it named, if any, by its number.
pub(crate) fn invoice_for_reference(reference: &str) -> String {
    conn().ok().and_then(|c| invoice_by_number(&c, reference.trim())).unwrap_or_default()
}

/// Whether a product has a live buy (an Add import into it is refused: each buy is its own stock).
pub(crate) fn item_has_buy(c: &rusqlite::Connection, item_id: &str) -> bool {
    buy_for(c, item_id, "").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::case_core::{CaseLine, LoadLine, SizeQty};
    use crate::warehouse_loads::{create_warehouse_load, save_warehouse_case, take_load_pairs, undo_load_out};

    fn invoice(id: &str, number: &str, total: f64) {
        let c = conn().unwrap();
        c.execute("INSERT OR IGNORE INTO clients (id,name,created_at,updated_at) VALUES ('cl1','Buyer','t','t')", []).unwrap();
        c.execute(
            "INSERT INTO invoices (id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,created_at) \
             VALUES (?1,'cl1',?2,'2026-10-01','2026-10-30','[]',?3,0,?3,'draft','2026-10-01')",
            rusqlite::params![id, number, total],
        )
        .unwrap();
    }

    fn bookings(txn: &str) -> Vec<(String, String, f64)> {
        let c = conn().unwrap();
        let mut v: Vec<(String, String, f64)> = allocs_where(&c, "a.bank_txn_id=?1", &[&txn]).into_iter().map(|a| (a.role, a.deal, a.amount)).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    }

    fn goods_line(invoice_id: &str) -> Option<SupplierPayment> {
        let c = conn().unwrap();
        let d = deal_of(&c, invoice_id)?;
        crate::commands::read_df(&d).ok()?.supplier_payments.into_iter().find(|p| p.id.starts_with("buyg-"))
    }

    /// A delivery sells to two invoices before its buy is recorded; recording it picks both up,
    /// a wire covers both, and putting one back holds its share as stock.
    #[tokio::test]
    async fn a_buy_recorded_late_costs_the_orders_already_sold_and_put_back_returns_the_share() {
        let _db = crate::db::init_test_store();
        let line = LoadLine { id: "a".into(), brand: "Acme".into(), style: "K1".into(), cost: 10.0, sizes: vec![SizeQty { size: "7".into(), qty: 10 }], ..Default::default() };
        let d = create_warehouse_load("Shoe truck".into(), "t.xlsx".into(), vec![line]).await.unwrap();
        let load = d.load.id.clone();
        save_warehouse_case(load.clone(), None, 1, vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 10 }], None, None, None, None).await.unwrap();
        invoice("ia", "A-1", 50.0);
        invoice("ib", "B-1", 90.0);
        take_load_pairs(load.clone(), Some("ia".into()), Some("A-1".into()), None, vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 4 }]).await.unwrap();
        take_load_pairs(load.clone(), Some("ib".into()), Some("B-1".into()), None, vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 6 }]).await.unwrap();

        // 10 pairs at $1.25 = $12.50, and $2.50 of shipping in, not paid yet.
        let v = create_warehouse_buy(BuyInput {
            item_id: None, load_id: Some(load.clone()), name: None, supplier_id: None, supplier_name: Some("Lamo".into()),
            units_bought: Some(10.0), goods_total: Some(12.5), ship_total: Some(2.5), notes: None,
        })
        .await
        .unwrap();
        assert_eq!(v["orders"].as_array().unwrap().len(), 2, "both earlier invoices came with the buy");
        assert_eq!(v["rollup"]["unit_cost"].as_f64().unwrap(), 1.5);
        let a = goods_line("ia").unwrap();
        assert_eq!((a.amount, a.paid), (5.0, false));
        assert!(crate::commands::is_buy_line(&a));
        assert_eq!(goods_line("ib").unwrap().amount, 7.5);

        // The wire pays the goods: both orders covered in full.
        conn().unwrap().execute("INSERT INTO bank_txn (id,direction,amount,posted_at) VALUES ('w1','out',12.5,'2026-10-02')", []).unwrap();
        let v = pay_warehouse_buy(v["buy"]["id"].as_str().unwrap().to_string(), Kind::Goods, Some("w1".into()), None, None, None).await.unwrap();
        assert!(v["in_step"].as_bool().unwrap());
        let (da, db_) = { let c = conn().unwrap(); (deal_of(&c, "ia").unwrap(), deal_of(&c, "ib").unwrap()) };
        let mut want = vec![("supplier_payment".to_string(), da.clone(), 5.0), ("supplier_payment".to_string(), db_.clone(), 7.5)];
        want.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(bookings("w1"), want);
        assert!(goods_line("ia").unwrap().paid);

        // B goes back on the delivery: its share is held on the wire and its line is gone.
        let out_b = crate::warehouse_loads::outs(&conn().unwrap(), &load).unwrap().into_iter().find(|o| o.invoice_id == "ib").unwrap();
        undo_load_out(load.clone(), out_b.id).await.unwrap();
        assert!(goods_line("ib").is_none());
        let buy_id = v["buy"]["id"].as_str().unwrap().to_string();
        let mut want = vec![("adjustment".to_string(), buy_id.clone(), 7.5), ("supplier_payment".to_string(), da, 5.0)];
        want.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(bookings("w1"), want);
        let v = get_warehouse_buy(buy_id).await.unwrap();
        assert!(v["in_step"].as_bool().unwrap());
        assert_eq!(v["rollup"]["sold"].as_f64().unwrap(), 4.0);
        assert_eq!(v["rollup"]["left"].as_f64().unwrap(), 6.0);
    }

    // ── R-551: a buy started before its stock is here, brought in on trucks ─────────────────

    fn on_the_way(name: &str, goods: f64, units: f64) -> BuyInput {
        BuyInput {
            item_id: None, load_id: None, name: Some(name.into()), supplier_id: None, supplier_name: Some("Lamo".into()),
            units_bought: Some(units), goods_total: Some(goods), ship_total: None, notes: None,
        }
    }

    /// A truck bringing `buy` in, straight into the local copy: `rate` is both its carrier rate and the carrier cost its
    /// quote was built on, `markup` his markup on it. A booked, picked up or delivered one carries a booking day.
    fn truck(buy: &str, status: &str, rate: Option<f64>, markup: Option<f64>, created: &str) -> String {
        let id = format!("fb_{}", uuid::Uuid::new_v4().simple());
        let booked = if matches!(status, "booked" | "picked_up" | "delivered") { "2026-10-05" } else { "" };
        conn()
            .unwrap()
            .execute(
                "INSERT INTO freight_bookings (id, buy_id, status, quoted_cost, quote_cost, markup_amount, booked_at, carrier, created_at, updated_at) \
                 VALUES (?1,?2,?3,?4,?4,?5,?6,'Test Freight',?7,?7)",
                rusqlite::params![id, buy, status, rate, markup, booked, created],
            )
            .unwrap();
        id
    }

    fn truck_set(id: &str, sets: &str) {
        conn().unwrap().execute(&format!("UPDATE freight_bookings SET {sets} WHERE id=?1"), [id]).unwrap();
    }

    /// The logistics pay rule as the server writes it into the settings; put back to nothing when dropped, so no other test
    /// reads it.
    struct Rule;
    impl Rule {
        fn set(json: &str) -> Rule {
            conn().unwrap().execute("INSERT INTO settings (key, value) VALUES ('logistics_pay', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [json]).unwrap();
            Rule
        }
    }
    impl Drop for Rule {
        fn drop(&mut self) {
            if let Ok(c) = conn() {
                let _ = c.execute("DELETE FROM settings WHERE key='logistics_pay'", []);
            }
        }
    }
    const PAYS: &str = r#"{"enabled":true,"payee_id":"lp_sample","surplus_mode":"pay"}"#;

    fn ship_line(invoice_id: &str) -> Option<SupplierPayment> {
        let c = conn().unwrap();
        let d = deal_of(&c, invoice_id)?;
        crate::commands::read_df(&d).ok()?.supplier_payments.into_iter().find(|p| p.id.starts_with("buys-"))
    }

    /// A delivery whose manifest expects `pairs` pairs, with them received.
    async fn delivery(name: &str, pairs: i64) -> String {
        use crate::case_core::{CaseLine, LoadLine, SizeQty};
        let line = LoadLine { id: "a".into(), brand: "Acme".into(), style: "K1".into(), cost: 10.0, sizes: vec![SizeQty { size: "7".into(), qty: pairs }], ..Default::default() };
        let d = create_warehouse_load(name.into(), "t.xlsx".into(), vec![line]).await.unwrap();
        let load = d.load.id.clone();
        save_warehouse_case(load.clone(), None, 1, vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs }], None, None, None, None).await.unwrap();
        load
    }

    fn pairs_of(n: i64) -> Vec<crate::case_core::CaseLine> {
        vec![crate::case_core::CaseLine { line_id: "a".into(), size: "7".into(), pairs: n }]
    }

    fn id_of(v: &Value) -> String {
        v["buy"]["id"].as_str().unwrap().to_string()
    }

    /// A buy begun on its own, with no stock and no count, reads On the way; its trucks set its shipping in (the quoted ones
    /// count, a quote still waiting costs nothing, a cancelled one is out); a typed figure, removing it and paying its shipping
    /// by hand are refused while a truck is live; then its stock is attached and takes the count from it.
    #[tokio::test]
    async fn a_buy_on_the_way_follows_its_trucks_and_takes_its_stock() {
        let _db = crate::db::init_test_store();
        let _off = Rule::set(r#"{"enabled":false}"#);

        let v = create_warehouse_buy(on_the_way("Sample hats", 1000.0, 0.0)).await.unwrap();
        let id = id_of(&v);
        assert_eq!((v["buy"]["on_the_way"].as_bool(), v["buy"]["units_bought"].as_f64()), (Some(true), Some(0.0)));
        assert_eq!(v["trucks"].as_array().unwrap().len(), 0);
        assert_eq!(create_warehouse_buy(on_the_way("  ", 5.0, 0.0)).await.unwrap_err(), "Say what it is.");
        assert_eq!(create_warehouse_buy(on_the_way("Sample", 5.0, -1.0)).await.unwrap_err(), "Enter how many were bought.");
        let mut with_stock = on_the_way("Sample", 5.0, 0.0);
        with_stock.load_id = Some("no-such-delivery".into());
        assert_eq!(create_warehouse_buy(with_stock).await.unwrap_err(), "Enter how many were bought.", "a buy with stock still needs its count");

        let l = list_warehouse_buys().await.unwrap();
        assert!(l["coming"].as_array().unwrap().iter().any(|b| b["id"] == id.as_str()), "it is listed under On the way");
        assert!(!l["stock"].as_array().unwrap().iter().any(|s| s["buy"]["id"] == id.as_str()), "and not among the stock");

        // One truck quoted with his markup, one still waiting for its quote.
        let t1 = truck(&id, "quoted", Some(1750.0), Some(20.0), "2026-10-05T10:00:00Z");
        let t2 = truck(&id, "quote", None, None, "2026-10-05T10:00:01Z");
        let v = get_warehouse_buy(id.clone()).await.unwrap();
        assert_eq!((v["truck_cost"]["live"].as_i64(), v["truck_cost"]["priced"].as_i64(), v["truck_cost"]["carrier"].as_f64()), (Some(2), Some(1), Some(1750.0)));
        assert_eq!((v["buy"]["ship_total"].as_f64(), v["buy"]["ship_typed"].as_f64()), (Some(1750.0), Some(0.0)), "a quoted truck counts at once");
        assert_eq!(v["buy"]["markup_total"].as_f64(), Some(0.0), "his markup counts only while the rule pays");
        let rows = v["trucks"].as_array().unwrap();
        assert_eq!((rows[0]["truck_no"].as_i64(), rows[1]["truck_no"].as_i64(), rows[0]["trucks"].as_i64()), (Some(1), Some(2), Some(2)));
        assert_eq!(rows[0]["code"].as_str().map(|c| c.starts_with("L-")), Some(true), "no load number yet reads the id-derived code");

        // The second truck is quoted, and the rule pays him: both counted, and his markup too.
        truck_set(&t2, "status='quoted', quoted_cost=1850, quote_cost=1850, markup_amount=10");
        let _pays = Rule::set(PAYS);
        let v = get_warehouse_buy(id.clone()).await.unwrap();
        assert_eq!((v["buy"]["ship_total"].as_f64(), v["buy"]["markup_total"].as_f64()), (Some(3600.0), Some(30.0)));

        // While a truck is live the typed shipping in, removing the buy and paying its shipping by hand are refused.
        let mut typed = on_the_way("Sample hats", 1000.0, 0.0);
        typed.ship_total = Some(5.0);
        assert_eq!(update_warehouse_buy(id.clone(), typed).await.unwrap_err(), "This buy's shipping in comes from its trucks.");
        let rename = on_the_way("Sample hats, renamed", 1000.0, 0.0);
        assert_eq!(update_warehouse_buy(id.clone(), rename).await.unwrap()["buy"]["name"], "Sample hats, renamed");
        assert_eq!(archive_warehouse_buy(id.clone()).await.unwrap_err(), "Cancel its trucks in Logistics first.");
        assert_eq!(pay_warehouse_buy(id.clone(), Kind::Ship, Some("w-r551".into()), None, None, None).await.unwrap_err(), "Tie the carrier payment to its truck.");
        truck_set(&t1, "bank_txn_id='w-r551'");
        assert_eq!(unpay_warehouse_buy(id.clone(), "w-r551".into()).await.unwrap_err(), "That payment is tied to a truck. Take it off the truck in Pay carriers.");

        // A truck cancelled costs nothing and has no place among the live ones.
        truck_set(&t2, "status='cancelled'");
        let v = get_warehouse_buy(id.clone()).await.unwrap();
        assert_eq!((v["buy"]["ship_total"].as_f64(), v["buy"]["markup_total"].as_f64(), v["truck_cost"]["live"].as_i64()), (Some(1750.0), Some(20.0), Some(1)));
        assert_eq!(v["trucks"][1]["truck_no"].as_i64(), Some(0));

        // Ten pairs are sold before the buy has its stock: attaching the delivery brings that order in and takes the count.
        let load = delivery("Shoe delivery R551", 10).await;
        invoice("r551a", "R551-A", 900.0);
        take_load_pairs(load.clone(), Some("r551a".into()), Some("R551-A".into()), None, pairs_of(4)).await.unwrap();
        let v = attach_warehouse_buy(id.clone(), None, Some(load.clone())).await.unwrap();
        assert_eq!((v["buy"]["load_id"].as_str(), v["buy"]["units_bought"].as_f64(), v["buy"]["on_the_way"].as_bool()), (Some(load.as_str()), Some(10.0), Some(false)));
        assert_eq!(v["orders"].as_array().unwrap().len(), 1, "the order already sold from it came with it");
        assert_eq!((v["unit_goods"].as_f64(), v["unit_ship"].as_f64(), v["unit_markup"].as_f64()), (Some(100.0), Some(175.0), Some(2.0)));
        assert_eq!((v["orders"][0]["ship"].as_f64(), v["orders"][0]["markup"].as_f64()), (Some(700.0), Some(8.0)));
        assert_eq!(v["rollup"]["unit_cost"].as_f64(), Some(277.0), "goods, shipping in and his markup, over the pairs");
        assert_eq!(ship_line("r551a").map(|p| p.amount), Some(700.0));
        let brief = warehouse_buy_for(None, Some(load.clone())).await.unwrap();
        assert_eq!((brief["buy"]["unit_ship"].as_f64(), brief["buy"]["unit_markup"].as_f64()), (Some(175.0), Some(2.0)));

        // The carrier is paid $50 less: the shipping in, and the order already sold, follow it.
        truck_set(&t1, "paid_amount=1700, paid_at='2026-10-20'");
        let v = apply_warehouse_buy(id.clone()).await.unwrap();
        assert_eq!((v["buy"]["ship_total"].as_f64(), v["unit_ship"].as_f64()), (Some(1700.0), Some(170.0)));
        assert_eq!(ship_line("r551a").map(|p| p.amount), Some(680.0));

        // Attaching again, or another buy to the same stock, or to nothing, is refused.
        assert_eq!(attach_warehouse_buy(id.clone(), None, Some(load.clone())).await.unwrap_err(), "This buy is already on its stock.");
        let other = id_of(&create_warehouse_buy(on_the_way("Sample caps", 50.0, 0.0)).await.unwrap());
        assert_eq!(attach_warehouse_buy(other.clone(), None, Some(load)).await.unwrap_err(), "This stock already has its buy. Change that one instead.");
        assert_eq!(attach_warehouse_buy(other.clone(), Some("a".into()), Some("b".into())).await.unwrap_err(), "Choose the product or the delivery this buy is for.");
        assert_eq!(attach_warehouse_buy(other.clone(), Some("no-such-product".into()), None).await.unwrap_err(), "That stock is no longer in the warehouse.");
        conn().unwrap().execute("INSERT INTO warehouse_items (id, name, sections_json, created_at, updated_at) VALUES ('wi-r551-empty','Empty shelf','[]','t','t')", []).unwrap();
        assert_eq!(attach_warehouse_buy(other, Some("wi-r551-empty".into()), None).await.unwrap_err(), "Enter how many were bought on the buy first.");
    }

    /// A product's units fill in a count left at 0, and a count that was typed stands.
    #[tokio::test]
    async fn attaching_a_product_takes_its_units_only_when_no_count_was_typed() {
        let _db = crate::db::init_test_store();
        let shelf = r#"[{"id":"s1","name":"Shelf","loose":12}]"#;
        for (id, name) in [("wi-r551-hats", "Hats"), ("wi-r551-caps", "Caps")] {
            conn().unwrap().execute("INSERT INTO warehouse_items (id, name, sections_json, created_at, updated_at) VALUES (?1,?2,?3,'t','t')", rusqlite::params![id, name, shelf]).unwrap();
        }
        let blank = id_of(&create_warehouse_buy(on_the_way("Hat pallets", 600.0, 0.0)).await.unwrap());
        let v = attach_warehouse_buy(blank, Some("wi-r551-hats".into()), None).await.unwrap();
        assert_eq!((v["buy"]["item_id"].as_str(), v["buy"]["units_bought"].as_f64(), v["unit_goods"].as_f64()), (Some("wi-r551-hats"), Some(12.0), Some(50.0)));
        let typed = id_of(&create_warehouse_buy(on_the_way("Cap pallets", 600.0, 20.0)).await.unwrap());
        let v = attach_warehouse_buy(typed, Some("wi-r551-caps".into()), None).await.unwrap();
        assert_eq!((v["buy"]["units_bought"].as_f64(), v["unit_goods"].as_f64()), (Some(20.0), Some(30.0)), "the count typed on the buy wins");
    }

    /// His markup on the trucks that brought a buy in is laid on its orders and taken off the top of each order's owner split
    /// as logistics pay: 4 of 10 pairs carry 4/10 of $30, the last order the rest. It counts only while the rule pays.
    #[tokio::test]
    async fn his_markup_on_a_buys_trucks_is_taken_off_each_orders_deal() {
        let _db = crate::db::init_test_store();
        let load = delivery("Shoe delivery R551 cut", 10).await;
        invoice("r551c1", "R551-C1", 500.0);
        invoice("r551c2", "R551-C2", 900.0);
        take_load_pairs(load.clone(), Some("r551c1".into()), Some("R551-C1".into()), None, pairs_of(4)).await.unwrap();
        take_load_pairs(load.clone(), Some("r551c2".into()), Some("R551-C2".into()), None, pairs_of(6)).await.unwrap();
        let mut input = on_the_way("Cut shoes", 100.0, 10.0);
        input.load_id = Some(load);
        let buy_id = id_of(&create_warehouse_buy(input).await.unwrap());
        truck(&buy_id, "booked", Some(80.0), Some(20.0), "2026-10-05T10:00:00Z");
        let cheap = truck(&buy_id, "booked", Some(90.0), Some(10.0), "2026-10-05T10:00:01Z");
        let (da, db_) = { let c = conn().unwrap(); (deal_of(&c, "r551c1").unwrap(), deal_of(&c, "r551c2").unwrap()) };
        let share = |d: &str| markup_on_deal(&conn().unwrap(), d);

        {
            let _rule = Rule::set(r#"{"enabled":false}"#);
            assert_eq!((share(&da), share(&db_)), (0.0, 0.0), "the rule is off");
            assert_eq!(crate::freight::logistics_cut(&conn().unwrap(), &da), None);
        }
        {
            let _rule = Rule::set(r#"{"enabled":true,"surplus_mode":"track"}"#);
            assert_eq!(share(&da), 0.0, "tracked, not paid: nothing is taken off");
        }
        {
            let _rule = Rule::set(r#"{"enabled":true,"surplus_mode":"pay"}"#);
            assert_eq!(share(&da), 0.0, "paying needs a payee");
        }
        let _rule = Rule::set(PAYS);
        assert_eq!((share(&da), share(&db_)), (12.0, 18.0));
        assert_eq!(share("df-no-such-deal"), 0.0);
        assert_eq!(crate::freight::logistics_cut(&conn().unwrap(), &da), Some(12.0));
        assert_eq!(crate::freight::logistics_cut_on_completion(&conn().unwrap(), &db_), Some(18.0));
        let line = crate::freight::get_deal_logistics_pay(da.clone()).await.unwrap();
        assert_eq!((line["pay"].as_f64(), line["buy_markup"].as_f64(), line["rule"].as_str()), (Some(12.0), Some(12.0), Some("markup")));
        let payout = crate::commands::deal_flow_payout(db_.clone()).await.unwrap();
        assert_eq!(payout["logistics_pay"].as_f64(), Some(18.0));

        // An order put back leaves the share to the one that stays: the 6 pairs left carry 6/10 of the $30.
        update_warehouse_buy_order(buy_id.clone(), core::order_id("r551c1", &buy_id), None, None, Some(true)).await.unwrap();
        assert_eq!((share(&da), share(&db_)), (0.0, 18.0));
        // A truck cancelled takes its markup out.
        truck_set(&cheap, "status='cancelled'");
        assert_eq!(share(&db_), 12.0, "6 of the 10 pairs carry 6/10 of the $20 of markup left");
    }

    fn out_row(id: &str, amount: f64, at: &str) {
        conn().unwrap().execute("INSERT INTO bank_txn (id,direction,amount,posted_at) VALUES (?1,'out',?2,?3)", rusqlite::params![id, amount, at]).unwrap();
    }
    fn goods_paid(v: &Value) -> (f64, f64) {
        (v["rollup"]["goods_paid"].as_f64().unwrap(), v["rollup"]["goods_total"].as_f64().unwrap())
    }

    /// R-552: a deposit and then the final payment both book, on a buy with no price typed (the price becomes what was paid)
    /// and on one with a price (a payment past it books all of it or only what is left, as asked); nothing is ever dropped,
    /// a buy paid in full says so, and taking a payment off in Financials takes all of it off the buy.
    #[tokio::test]
    async fn r552_a_deposit_and_the_final_payment_always_book() {
        let _db = crate::db::init_test_store();

        // No price typed: the deposit becomes the price; the final payment asks, and Book all raises it.
        let id = id_of(&create_warehouse_buy(on_the_way("Sample tees", 0.0, 0.0)).await.unwrap());
        out_row("dep", 10_000.0, "2026-10-01");
        out_row("fin", 40_000.0, "2026-10-09");
        let v = pay_warehouse_buy(id.clone(), Kind::Goods, Some("dep".into()), None, None, None).await.unwrap();
        assert_eq!(goods_paid(&v), (10_000.0, 10_000.0), "no price typed: the price is what was paid");
        assert_eq!(v["payments"].as_array().unwrap().len(), 1, "the deposit shows on the buy");
        assert_eq!(bookings("dep"), vec![("adjustment".into(), id.clone(), 10_000.0)], "held on the buy until the stock sells");
        assert_eq!(pay_warehouse_buy(id.clone(), Kind::Goods, Some("fin".into()), None, None, None).await.unwrap_err(), core::PAY_PAID_IN_FULL);
        assert_eq!(bookings("fin"), vec![], "a refusal writes nothing");
        let v = pay_warehouse_buy(id.clone(), Kind::Goods, Some("fin".into()), None, None, Some(core::Take::All)).await.unwrap();
        assert_eq!(goods_paid(&v), (50_000.0, 50_000.0));
        assert_eq!(v["payments"].as_array().unwrap().len(), 2);
        assert_eq!(pay_warehouse_buy(id.clone(), Kind::Goods, Some("fin".into()), None, None, None).await.unwrap_err(), core::PAY_ALREADY_HERE);
        assert_eq!(
            pay_warehouse_buy(id.clone(), Kind::Ship, Some("fin".into()), None, None, None).await.unwrap_err(),
            "That bank row already pays the goods on this buy. Take it off first to use it for the shipping in."
        );

        // A price typed: the deposit and the exact rest need no question; a bigger final payment books only what is left.
        let id2 = id_of(&create_warehouse_buy(on_the_way("Sample hoodies", 50_000.0, 0.0)).await.unwrap());
        out_row("dep2", 10_000.0, "2026-10-01");
        out_row("fin2", 45_000.0, "2026-10-09");
        let v = pay_warehouse_buy(id2.clone(), Kind::Goods, Some("dep2".into()), None, None, None).await.unwrap();
        assert_eq!(goods_paid(&v), (10_000.0, 50_000.0));
        let v = pay_warehouse_buy(id2.clone(), Kind::Goods, Some("fin2".into()), None, None, Some(core::Take::Left)).await.unwrap();
        assert_eq!(goods_paid(&v), (50_000.0, 50_000.0), "only what was left");
        let fin = v["payments"].as_array().unwrap().iter().find(|p| p["txn_id"] == "fin2").unwrap().clone();
        assert_eq!((fin["amount"].as_f64(), fin["booked_here"].as_f64()), (Some(45_000.0), Some(40_000.0)), "the rest stays free");

        // Financials' bin on one of the buy's bookings takes the whole payment off the buy.
        let held = allocs_where(&conn().unwrap(), "a.bank_txn_id=?1", &[&"fin2"]).remove(0);
        crate::commands::remove_bank_allocation(held.id).await.unwrap();
        assert_eq!(bookings("fin2"), vec![]);
        assert_eq!(goods_paid(&get_warehouse_buy(id2.clone()).await.unwrap()), (10_000.0, 50_000.0));

        // Cash past what is left asks the same way, and a refusal leaves no cash row behind.
        let before: i64 = conn().unwrap().query_row("SELECT COUNT(*) FROM bank_txn", [], |r| r.get(0)).unwrap();
        let v = pay_warehouse_buy(id2.clone(), Kind::Goods, None, Some(45_000.0), Some("2026-10-10".into()), Some(core::Take::All)).await.unwrap();
        assert_eq!(goods_paid(&v), (55_000.0, 55_000.0), "Book all raises the price to what was paid");
        assert_eq!(pay_warehouse_buy(id2.clone(), Kind::Goods, None, Some(5.0), None, None).await.unwrap_err(), core::PAY_PAID_IN_FULL);
        let after: i64 = conn().unwrap().query_row("SELECT COUNT(*) FROM bank_txn", [], |r| r.get(0)).unwrap();
        assert_eq!(after, before + 1, "one cash row, for the payment that booked");

        // The choices Financials lists carry each leg's price and what is paid.
        let c = warehouse_buy_choices(None).await.unwrap();
        let b = c.as_array().unwrap().iter().find(|b| b["id"] == id2.as_str()).unwrap().clone();
        assert_eq!((b["goods_total"].as_f64(), b["goods_paid"].as_f64(), b["on_the_way"].as_bool()), (Some(55_000.0), Some(55_000.0), Some(true)));
    }
}
