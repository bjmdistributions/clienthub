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

/// Every booking the buy owns: what it holds on itself, and its bookings on its orders' deals.
fn owned_allocs(c: &rusqlite::Connection, buy_id: &str, deals: &[String]) -> Vec<Alloc> {
    let mut v = allocs_where(c, "a.deal_flow_id=?1 AND a.role='adjustment'", &[&buy_id]);
    for d in deals {
        v.extend(allocs_where(c, "a.deal_flow_id=?1 AND a.role IN ('supplier_payment','fee') AND a.note LIKE 'Buy: %'", &[d]));
    }
    v
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
    let others: f64 = allocs_where(c, "a.bank_txn_id=?1", &[&id]).iter().filter(|a| !owned_ids.contains(&a.id)).map(|a| a.amount).sum();
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
    sections.iter().map(|s| wc::units_of(&types, s) as f64).sum()
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
            "INSERT INTO bank_allocation (id, org_id, bank_txn_id, deal_flow_id, amount, role, note, created_by, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
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
    plan: core::Plan,
    wants: Vec<Want>,
    lines: BTreeMap<String, (Vec<SupplierPayment>, Vec<SupplierPayment>, String)>,
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
    let deals: Vec<String> = deal_of_order.values().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let owned = owned_allocs(c, &b.id, &deals);
    let owned_ids: BTreeSet<String> = owned.iter().map(|a| a.id.clone()).collect();
    let mut kinds: BTreeMap<String, Kind> = BTreeMap::new();
    for a in &owned {
        kinds.entry(a.txn_id.clone()).or_insert(kind_of(a));
    }
    if let Some((t, k)) = link {
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
    let t = core::Totals { units: b.units, goods: b.goods, ship: b.ship };
    let ins: Vec<core::OrderIn> = live.iter().map(|o| core::OrderIn { id: o.id.clone(), count: o.count, goods_typed: o.goods_typed, own_cost: o.own_cost }).collect();
    let rins: Vec<core::RowIn> = rows
        .iter()
        .map(|(id, (k, i))| core::RowIn { txn_id: id.clone(), kind: *k, room: core::r2(i.amount - i.others), posted_at: i.posted_at.clone() })
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
        lines.insert(d.clone(), (want_lines, now_lines, stage));
    }
    Ok(Worked { b, ords, deal_of_order, owned, rows, plan, wants, lines })
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

fn is_ours(p: &SupplierPayment) -> bool {
    p.id.starts_with("buyg-") || p.id.starts_with("buys-")
}

fn merged(want: &[SupplierPayment], now_lines: &[SupplierPayment]) -> Option<Vec<SupplierPayment>> {
    let ours_now: Vec<&SupplierPayment> = now_lines.iter().filter(|p| is_ours(p)).collect();
    let unchanged = ours_now.len() == want.len() && want.iter().all(|w| ours_now.iter().any(|n| n.id == w.id && same_line(n, w)));
    if unchanged {
        return None;
    }
    let mut out: Vec<SupplierPayment> = Vec::new();
    for p in now_lines {
        if !is_ours(p) {
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
    bank_ok && w.lines.values().all(|(want, now_lines, _)| merged(want, now_lines).is_none())
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
                        id: format!("alloc_{}", uuid::Uuid::new_v4().simple()),
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

    for (deal, (want, now_lines, _)) in &w.lines {
        if let Some(next) = merged(want, now_lines) {
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
    let t = core::Totals { units: w.b.units, goods: w.b.goods, ship: w.b.ship };
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
                "goods": p.map(|p| p.goods).unwrap_or(0.0), "ship": p.map(|p| p.ship).unwrap_or(0.0),
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
            "goods_total": w.b.goods, "ship_total": w.b.ship, "notes": w.b.notes, "archived": w.b.archived,
            "created_at": w.b.created_at, "updated_at": w.b.updated_at,
        },
        "rollup": roll,
        "unit_goods": w.plan.unit_goods, "unit_ship": w.plan.unit_ship,
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
    Ok(json!({ "stock": stock }))
}

/// The live buy on a product or a delivery, for the invoice form's cost line.
#[tauri::command]
pub async fn warehouse_buy_for(item_id: Option<String>, load_id: Option<String>) -> Result<Value, String> {
    let c = conn()?;
    let Some(b) = buy_for(&c, item_id.as_deref().unwrap_or(""), load_id.as_deref().unwrap_or("")) else { return Ok(json!({ "buy": null })) };
    let units = b.units.max(0.0);
    let sold: f64 = orders(&c, &b.id).iter().filter(|o| !o.undone).map(|o| o.count).sum();
    let (ug, us) = if units > 0.0 { (b.goods / units, b.ship / units) } else { (0.0, 0.0) };
    Ok(json!({ "buy": { "id": b.id, "name": b.name, "units_bought": b.units, "sold": sold, "unit_goods": ug, "unit_ship": us } }))
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

fn check_money(units: f64, goods: f64, ship: f64) -> Result<(), String> {
    if !(units > 0.0) || !units.is_finite() {
        return Err("Enter how many were bought.".into());
    }
    if !(goods >= 0.0) || !goods.is_finite() || !(ship >= 0.0) || !ship.is_finite() {
        return Err("Enter what was paid, as a number.".into());
    }
    Ok(())
}

fn new_order(buy_id: &str, invoice_id: &str, count: f64, goods_typed: Option<f64>, own_cost: bool, at: &str) -> Result<String, String> {
    let oid = core::order_id(invoice_id, buy_id);
    if conn()?.query_row("SELECT 1 FROM warehouse_buy_orders WHERE id=?1", [&oid], |_| Ok(())).is_ok() {
        return Ok(oid);
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
/// except that a deal whose supplier cost was typed by hand keeps that cost.
#[tauri::command]
pub async fn create_warehouse_buy(input: BuyInput) -> Result<Value, String> {
    let (item_id, load_id) = (input.item_id.unwrap_or_default(), input.load_id.unwrap_or_default());
    let (units, goods, ship) = (input.units_bought.unwrap_or(0.0), core::r2(input.goods_total.unwrap_or(0.0)), core::r2(input.ship_total.unwrap_or(0.0)));
    check_money(units, goods, ship)?;
    if item_id.is_empty() == load_id.is_empty() {
        return Err("Choose the product or the delivery this buy is for.".into());
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
    let b = buy(&*conn()?, &id)?;
    let units = input.units_bought.unwrap_or(b.units);
    let goods = core::r2(input.goods_total.unwrap_or(b.goods));
    let ship = core::r2(input.ship_total.unwrap_or(b.ship));
    check_money(units, goods, ship)?;
    let mut cols = Map::new();
    if let Some(n) = input.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cols.insert("name".into(), json!(n));
    }
    if let Some(s) = input.supplier_name.as_deref() {
        cols.insert("supplier_name".into(), json!(s.trim()));
        cols.insert("supplier_id".into(), json!(input.supplier_id.clone().unwrap_or_default()));
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

/// Remove a buy recorded by mistake: only while nothing hangs on it. Archived, never deleted.
#[tauri::command]
pub async fn archive_warehouse_buy(id: String) -> Result<(), String> {
    {
        let w = work(&*conn()?, &id, None, None)?;
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
pub async fn pay_warehouse_buy(id: String, kind: Kind, txn_id: Option<String>, cash_amount: Option<f64>, cash_date: Option<String>) -> Result<Value, String> {
    if !crate::employees::session_can_book_bank() {
        return Err(NEEDS_FINANCIALS.into());
    }
    let b = buy(&*conn()?, &id)?;
    let txn = match (txn_id.as_deref().map(str::trim).filter(|s| !s.is_empty()), cash_amount) {
        (Some(t), _) => {
            let dir: String = conn()?
                .query_row("SELECT COALESCE(direction,'') FROM bank_txn WHERE id=?1", [t], |r| r.get(0))
                .map_err(|_| "That bank row is no longer here.".to_string())?;
            if dir != "out" {
                return Err("Choose money that went out, not money that came in.".into());
            }
            t.to_string()
        }
        (None, Some(a)) if a > 0.0 && a.is_finite() => {
            let desc = match kind {
                Kind::Goods => format!("Cash paid for {}", b.name),
                Kind::Ship => format!("Cash paid for shipping in, {}", b.name),
            };
            let cp = if kind == Kind::Goods { Some(b.supplier_name.clone()) } else { None };
            crate::commands::add_cash_transaction(core::r2(a), "out".into(), cash_date.unwrap_or_default(), cp, Some(desc)).await?
        }
        _ => return Err("Choose the bank row that paid it, or enter the cash paid.".into()),
    };
    apply(&id, Some((&txn, kind)), None)?;
    detail(&*conn()?, &id)
}

/// Take a bank row off the buy: every booking the buy made on it goes.
#[tauri::command]
pub async fn unpay_warehouse_buy(id: String, txn_id: String) -> Result<Value, String> {
    if !crate::employees::session_can_book_bank() {
        return Err(NEEDS_FINANCIALS.into());
    }
    apply(&id, None, Some(&txn_id))?;
    detail(&*conn()?, &id)
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
        save_warehouse_case(load.clone(), None, 1, vec![CaseLine { line_id: "a".into(), size: "7".into(), pairs: 10 }], None, None, None).await.unwrap();
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
        let v = pay_warehouse_buy(v["buy"]["id"].as_str().unwrap().to_string(), Kind::Goods, Some("w1".into()), None, None).await.unwrap();
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
}
