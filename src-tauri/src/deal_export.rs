//! R-467: the deal records workbook. Every deal flow with its items, every dated money
//! movement and every date, so the books can be cross-referenced against bank statements
//! and supplier records at any time (Jack, 2026-10-07, after June's deals stopped adding up).
//!
//! Byte-identical in `BUSINESS APP/src-tauri/src` and `clienthub-api/src`, like
//! `bills_core.rs`: the desktop saves it from Deal Flow, the server sends it to the website
//! and the phone, and both must write the same file from the same synced rows, so both run
//! this file. No `use crate::`. Read-only: it never writes a row.
//!
//! Three sheets:
//! - **Deals**: one row per deal flow, archived and fallen-through ones included, saying
//!   whether its profit is counted and in which month. The rule is the one every month's
//!   profit uses (desktop `month_profit_sql`, server `dashboard.rs` SURVIVOR): complete, deal
//!   not archived, invoice not voided or archived, and the first complete deal on its invoice.
//!   The month is `completed_at`'s `YYYY-MM`, read as the same text the app compares.
//! - **Items**: one row per invoice line.
//! - **Money**: one row per money movement on a deal, oldest first within each deal: the buyer
//!   payment entered on the deal, every cost line, every bank transaction tied to it, every
//!   refund and every carrier load.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::Value;

/// The refunds a deal's profit and revenue come down by, each counted once: a refund typed with
/// no bank row, plus every `refund_out` link to a bank row that still exists. Character-identical
/// to the desktop's `DF_REFUNDS_SQL`. `df` must be in scope.
pub const REFUNDS_SQL: &str =
    "COALESCE((SELECT SUM(x.amt) FROM ( \
            SELECT r.amount AS amt, r.deal_flow_id AS dfid FROM refunds r WHERE COALESCE(r.bank_txn_id,'')='' \
            UNION ALL \
            SELECT a.amount, a.deal_flow_id FROM bank_allocation a WHERE a.role='refund_out' \
              AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id) \
          ) x WHERE x.dfid = df.id),0)";

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Text(String),
    Money(f64),
    Num(f64),
}

fn t(s: impl Into<String>) -> Cell {
    Cell::Text(s.into())
}

/// The three sheets as rows, before any of it is written. Split from `workbook` so the tests
/// read the figures rather than a zip.
#[derive(Debug, Default)]
pub struct Records {
    pub deals: Vec<Vec<Cell>>,
    pub items: Vec<Vec<Cell>>,
    pub money: Vec<Vec<Cell>>,
}

pub const DEAL_HEADERS: &[(&str, f64)] = &[
    ("Invoice", 11.0), ("Deal", 26.0), ("Client", 24.0), ("Supplier", 24.0), ("Stage", 14.0),
    ("Counted in profit", 34.0), ("Profit month", 12.0),
    ("Created", 11.0), ("Invoice date", 11.0), ("Invoice sent", 11.0), ("Buyer paid", 11.0),
    ("Suppliers paid", 12.0), ("Pickup", 11.0), ("Delivery", 11.0), ("Completed", 11.0),
    ("Invoice total", 13.0), ("Received", 13.0), ("Deposit", 12.0), ("Revenue", 13.0),
    ("Cost", 13.0), ("Profit", 13.0), ("Refunds", 12.0), ("Revenue after refunds", 14.0),
    ("Profit after refunds", 14.0), ("Category", 16.0), ("Brand", 16.0), ("Loads", 14.0),
    ("Notes", 40.0),
];

pub const ITEM_HEADERS: &[(&str, f64)] = &[
    ("Invoice", 11.0), ("Deal", 26.0), ("Client", 24.0), ("Invoice date", 11.0),
    ("Item", 48.0), ("Qty", 9.0), ("Price", 12.0), ("Amount", 13.0),
];

pub const MONEY_HEADERS: &[(&str, f64)] = &[
    ("Invoice", 11.0), ("Deal", 26.0), ("Client", 24.0), ("Date", 11.0), ("What", 24.0),
    ("In or out", 9.0), ("Amount", 13.0), ("Status", 26.0), ("Who", 24.0), ("Method", 12.0),
    ("Bank row amount", 14.0), ("Account", 16.0), ("Bank memo", 40.0), ("Notes", 40.0),
];

/// A stored instant as its Central calendar day (an evening payment in UTC is already the next
/// day); a bare date, or anything that is not an RFC 3339 instant, is kept as its first ten
/// characters.
fn day(s: &str) -> String {
    let s = s.trim();
    if s.len() > 10 {
        if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(s) {
            return ts.with_timezone(&chrono_tz::America::Chicago).format("%Y-%m-%d").to_string();
        }
    }
    s.chars().take(10).collect()
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn cost_label(category: Option<&str>) -> &'static str {
    match category.unwrap_or("") {
        "freight" => "Freight",
        "wire_in" => "Incoming wire fee",
        "wire_out" => "Outgoing wire fee",
        "partner" => "Partner cut",
        "other" => "Other cost",
        _ => "Supplier cost",
    }
}

fn bank_role_label(role: &str) -> String {
    match role {
        "buyer_payment" => "Bank: buyer payment".into(),
        "supplier_payment" => "Bank: supplier payment".into(),
        "refund_out" => "Bank: refund paid".into(),
        "refund_in" => "Bank: refund received".into(),
        "shipping" => "Bank: shipping".into(),
        "fee" => "Bank: fee".into(),
        "adjustment" => "Bank: adjustment".into(),
        other => format!("Bank: {other}"),
    }
}

fn s_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

fn f_of(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim().parse().ok())))
}

/// One money row, kept with the date it sorts on.
struct MoneyRow {
    date: String,
    cells: Vec<Cell>,
}

/// Every deal flow in `org` (`""` = every row, which is the desktop: its database holds one
/// workspace), as the three sheets' rows.
pub fn collect(conn: &Connection, org: &str) -> Result<Records, String> {
    let e = |x: rusqlite::Error| x.to_string();

    // Bank rows tied to each deal.
    let mut bank: HashMap<String, Vec<MoneyRow>> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT a.deal_flow_id, a.amount, a.role, COALESCE(a.note,''), COALESCE(bt.posted_at,''), bt.direction, \
                    bt.amount, COALESCE(bt.description,''), COALESCE(bt.counterparty_name,''), COALESCE(bt.account_id,'') \
             FROM bank_allocation a JOIN bank_txn bt ON bt.id = a.bank_txn_id \
             JOIN deal_flows df ON df.id = a.deal_flow_id \
             WHERE (?1 = '' OR df.org_id = ?1)").map_err(e)?;
        let rows = st.query_map([org], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, f64>(6)?, r.get::<_, String>(7)?,
            r.get::<_, String>(8)?, r.get::<_, String>(9)?,
        ))).map_err(e)?;
        for row in rows {
            let (dfid, amount, role, note, posted, dir, bt_amount, memo, who, account) = row.map_err(e)?;
            let date = day(&posted);
            bank.entry(dfid).or_default().push(MoneyRow {
                date: date.clone(),
                cells: vec![
                    t(date), t(bank_role_label(&role)), t(if dir == "in" { "In" } else { "Out" }), Cell::Money(r2(amount)),
                    t("Linked to the deal"), t(who), t(""), Cell::Money(r2(bt_amount)), t(account), t(memo), t(note),
                ],
            });
        }
    }

    // Refunds recorded on each deal.
    let mut refunds: HashMap<String, Vec<MoneyRow>> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT r.deal_flow_id, r.amount, COALESCE(r.method,''), COALESCE(r.reason,''), \
                    COALESCE(NULLIF(r.refunded_at,''), r.created_at, ''), COALESCE(r.bank_txn_id,'') \
             FROM refunds r JOIN deal_flows df ON df.id = r.deal_flow_id \
             WHERE (?1 = '' OR df.org_id = ?1)").map_err(e)?;
        let rows = st.query_map([org], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, String>(4)?, r.get::<_, String>(5)?,
        ))).map_err(e)?;
        for row in rows {
            let (dfid, amount, method, reason, when, bank_id) = row.map_err(e)?;
            let date = day(&when);
            // A refund linked to a bank row is counted through that row's `refund_out` link, so
            // it is listed here only so the two can be matched up.
            let status = if bank_id.is_empty() { "Counted" } else { "Counted on its bank row" };
            refunds.entry(dfid).or_default().push(MoneyRow {
                date: date.clone(),
                cells: vec![
                    t(date), t("Refund"), t("Out"), Cell::Money(r2(amount)), t(status), t(""), t(method),
                    t(""), t(""), t(""), t(reason),
                ],
            });
        }
    }

    // Carrier loads: the live bookings only (never a quote, never cancelled or archived), the
    // same set the deal's "Shipping paid" adds up.
    let mut loads: HashMap<String, Vec<MoneyRow>> = HashMap::new();
    let mut load_numbers: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT fb.deal_flow_id, COALESCE(fb.load_number,''), COALESCE(fb.carrier,''), fb.status, \
                    fb.quoted_cost, fb.paid_amount, COALESCE(fb.paid_at,''), COALESCE(fb.paid_method,''), COALESCE(fb.paid_note,'') \
             FROM freight_bookings fb JOIN deal_flows df ON df.id = fb.deal_flow_id \
             WHERE (?1 = '' OR df.org_id = ?1) AND COALESCE(fb.archived,0) = 0 \
               AND fb.status NOT IN ('cancelled','quote','quoted')").map_err(e)?;
        let rows = st.query_map([org], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, Option<f64>>(4)?, r.get::<_, Option<f64>>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))).map_err(e)?;
        for row in rows {
            let (dfid, number, carrier, status, quoted, paid, paid_at, method, note) = row.map_err(e)?;
            let date = if paid.is_some() { day(&paid_at) } else { String::new() };
            let (amount, state) = match (paid, quoted) {
                (Some(p), _) => (p, "Paid".to_string()),
                (None, Some(q)) => (q, "Not paid yet (quoted)".to_string()),
                (None, None) => (0.0, "Not paid yet, no price".to_string()),
            };
            let label = if number.is_empty() { format!("Load, {status}") } else { format!("Load {number}, {status}") };
            if !number.is_empty() { load_numbers.entry(dfid.clone()).or_default().push(number); }
            loads.entry(dfid).or_default().push(MoneyRow {
                date: date.clone(),
                cells: vec![
                    t(date), t("Carrier pay"), t("Out"), Cell::Money(r2(amount)), t(state), t(carrier), t(method),
                    t(""), t(""), t(""), t(if note.is_empty() { label } else { format!("{label}. {note}") }),
                ],
            });
        }
    }

    let sql = format!(
        "SELECT df.id, COALESCE(df.name,''), COALESCE(i.number,''), COALESCE(c.name,''), df.stage, \
                COALESCE(df.category,''), COALESCE(df.brand,''), COALESCE(df.created_at,''), \
                COALESCE(i.issue_date,''), COALESCE(i.sent_at,''), COALESCE(df.payment_received_at,''), \
                COALESCE(df.completed_at,''), COALESCE(df.pickup_date,''), COALESCE(df.expected_delivery_date,''), \
                COALESCE(i.total,0), COALESCE(df.payment_received_amount,0), COALESCE(df.deposit_amount,0), \
                COALESCE(df.gross_revenue,0), COALESCE(df.total_cost,0), COALESCE(df.net_profit,0), {REFUNDS_SQL}, \
                COALESCE(df.archived,0), COALESCE(i.voided,0), COALESCE(i.archived,0), i.id IS NOT NULL, \
                (SELECT MIN(d2.id) FROM deal_flows d2 WHERE d2.invoice_id = df.invoice_id AND d2.stage='complete' \
                   AND COALESCE(d2.archived,0)=0), \
                COALESCE(df.supplier_payments_json,'[]'), COALESCE(i.line_items_json,'[]'), COALESCE(df.notes,''), \
                COALESCE(df.payment_received_method,'') \
         FROM deal_flows df LEFT JOIN invoices i ON i.id = df.invoice_id LEFT JOIN clients c ON c.id = i.client_id \
         WHERE (?1 = '' OR df.org_id = ?1) \
         ORDER BY COALESCE(NULLIF(i.issue_date,''), df.created_at) DESC, i.number DESC, df.id");
    let mut st = conn.prepare(&sql).map_err(e)?;
    let rows = st.query_map([org], |r| {
        Ok(DealRow {
            id: r.get(0)?, name: r.get(1)?, invoice: r.get(2)?, client: r.get(3)?, stage: r.get(4)?,
            category: r.get(5)?, brand: r.get(6)?, created: r.get(7)?, issued: r.get(8)?, sent: r.get(9)?,
            buyer_paid: r.get(10)?, completed: r.get(11)?, pickup: r.get(12)?, delivery: r.get(13)?,
            invoice_total: r.get(14)?, received: r.get(15)?, deposit: r.get(16)?, revenue: r.get(17)?,
            cost: r.get(18)?, profit: r.get(19)?, refunds: r.get(20)?, archived: r.get::<_, i64>(21)? != 0,
            voided: r.get::<_, i64>(22)? != 0, inv_archived: r.get::<_, i64>(23)? != 0,
            has_invoice: r.get::<_, i64>(24)? != 0, survivor: r.get(25)?, costs_json: r.get(26)?,
            items_json: r.get(27)?, notes: r.get(28)?, buyer_method: r.get(29)?,
        })
    }).map_err(e)?;

    let mut out = Records::default();
    for row in rows {
        let d = row.map_err(e)?;
        let head = |cells: Vec<Cell>| -> Vec<Cell> {
            let mut v = vec![t(d.invoice.clone()), t(d.name.clone()), t(d.client.clone())];
            v.extend(cells);
            v
        };

        let costs: Vec<Value> = serde_json::from_str(&d.costs_json).unwrap_or_default();
        let is_supplier_line = |c: &Value| matches!(c.get("category").and_then(|x| x.as_str()), None | Some("") | Some("supplier"));
        let mut suppliers: Vec<String> = Vec::new();
        let mut suppliers_paid = String::new();
        for c in costs.iter().filter(|c| is_supplier_line(c)) {
            let name = s_of(c, "supplier_name");
            if !name.is_empty() && !suppliers.contains(&name) { suppliers.push(name); }
            let paid = c.get("paid").and_then(|x| x.as_bool()).unwrap_or(false);
            let kept = c.get("kept").and_then(|x| x.as_bool()).unwrap_or(false);
            if paid && !kept {
                let when = day(&s_of(c, "paid_at"));
                if when > suppliers_paid { suppliers_paid = when; }
            }
        }

        // Counted exactly when the month's profit counts it; otherwise the first reason it is not.
        let counted = if d.stage != "complete" {
            "No: not complete".to_string()
        } else if d.archived {
            "No: deal archived".to_string()
        } else if !d.has_invoice {
            "No: its invoice is missing".to_string()
        } else if d.voided {
            "No: fell through".to_string()
        } else if d.inv_archived {
            "No: invoice archived".to_string()
        } else if d.survivor.as_deref() != Some(d.id.as_str()) {
            "No: another deal on this invoice is counted".to_string()
        } else {
            "Yes".to_string()
        };
        let month: String = if counted == "Yes" { d.completed.chars().take(7).collect() } else { String::new() };
        let loads_of = load_numbers.get(&d.id).map(|v| v.join(" ")).unwrap_or_default();

        out.deals.push(head(vec![
            t(suppliers.join(", ")), t(d.stage.clone()), t(counted), t(month),
            t(day(&d.created)), t(d.issued.chars().take(10).collect::<String>()), t(day(&d.sent)), t(day(&d.buyer_paid)),
            t(suppliers_paid), t(d.pickup.chars().take(10).collect::<String>()),
            t(d.delivery.chars().take(10).collect::<String>()), t(d.completed.chars().take(10).collect::<String>()),
            Cell::Money(r2(d.invoice_total)), Cell::Money(r2(d.received)), Cell::Money(r2(d.deposit)),
            Cell::Money(r2(d.revenue)), Cell::Money(r2(d.cost)), Cell::Money(r2(d.profit)),
            Cell::Money(r2(d.refunds)), Cell::Money(r2(d.revenue - d.refunds)), Cell::Money(r2(d.profit - d.refunds)),
            t(d.category.clone()), t(d.brand.clone()), t(loads_of), t(d.notes.clone()),
        ]));

        let items: Vec<Value> = serde_json::from_str(&d.items_json).unwrap_or_default();
        for it in &items {
            let qty = f_of(it, "qty").unwrap_or(0.0);
            let rate = f_of(it, "rate").unwrap_or(0.0);
            let amount = f_of(it, "amount").unwrap_or(qty * rate);
            out.items.push(head(vec![
                t(d.issued.chars().take(10).collect::<String>()), t(s_of(it, "description")),
                Cell::Num(qty), Cell::Money(r2(rate)), Cell::Money(r2(amount)),
            ]));
        }

        let mut money: Vec<MoneyRow> = Vec::new();
        if d.received.abs() > 0.004 {
            let date = day(&d.buyer_paid);
            money.push(MoneyRow {
                date: date.clone(),
                cells: vec![
                    t(date), t("Buyer payment (entered on the deal)"), t("In"), Cell::Money(r2(d.received)),
                    t("Entered"), t(d.client.clone()), t(d.buyer_method.clone()), t(""), t(""), t(""), t(""),
                ],
            });
        }
        for c in &costs {
            let paid = c.get("paid").and_then(|x| x.as_bool()).unwrap_or(false);
            let kept = c.get("kept").and_then(|x| x.as_bool()).unwrap_or(false);
            let status = if kept { "Kept, not a cost" } else if paid { "Paid" } else { "Unpaid" };
            let date = if paid { day(&s_of(c, "paid_at")) } else { String::new() };
            let mut note = s_of(c, "notes");
            if let (Some(q), Some(u)) = (f_of(c, "quantity"), f_of(c, "unit_price")) {
                let qty = format!("{q} at {u:.2}");
                note = if note.is_empty() { qty } else { format!("{qty}. {note}") };
            }
            money.push(MoneyRow {
                date: date.clone(),
                cells: vec![
                    t(date), t(cost_label(c.get("category").and_then(|x| x.as_str()))), t("Out"),
                    Cell::Money(r2(f_of(c, "amount").unwrap_or(0.0))), t(status), t(s_of(c, "supplier_name")),
                    t(s_of(c, "method")), t(""), t(""), t(""), t(note),
                ],
            });
        }
        money.extend(bank.remove(&d.id).unwrap_or_default());
        money.extend(refunds.remove(&d.id).unwrap_or_default());
        money.extend(loads.remove(&d.id).unwrap_or_default());
        // Oldest first; a movement with no date yet (an unpaid cost) goes last.
        money.sort_by(|a, b| (a.date.is_empty(), &a.date).cmp(&(b.date.is_empty(), &b.date)));
        for m in money {
            out.money.push(head(m.cells));
        }
    }
    Ok(out)
}

struct DealRow {
    id: String, name: String, invoice: String, client: String, stage: String, category: String,
    brand: String, created: String, issued: String, sent: String, buyer_paid: String, completed: String,
    pickup: String, delivery: String, invoice_total: f64, received: f64, deposit: f64, revenue: f64,
    cost: f64, profit: f64, refunds: f64, archived: bool, voided: bool, inv_archived: bool,
    has_invoice: bool, survivor: Option<String>, costs_json: String, items_json: String, notes: String,
    buyer_method: String,
}

/// The workbook as `.xlsx` bytes, and how many deals it holds.
pub fn workbook(conn: &Connection, org: &str) -> Result<(Vec<u8>, usize), String> {
    use rust_xlsxwriter::{Format, Workbook};
    let rec = collect(conn, org)?;
    let mut wb = Workbook::new();
    let bold = Format::new().set_bold();
    let money = Format::new().set_num_format("$#,##0.00");
    for (name, headers, rows) in [
        ("Deals", DEAL_HEADERS, &rec.deals),
        ("Items", ITEM_HEADERS, &rec.items),
        ("Money", MONEY_HEADERS, &rec.money),
    ] {
        let e = |x: rust_xlsxwriter::XlsxError| format!("{name} sheet: {x}");
        let ws = wb.add_worksheet();
        ws.set_name(name).map_err(e)?;
        for (c, (h, w)) in headers.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &bold).map_err(e)?;
            ws.set_column_width(c as u16, *w).map_err(e)?;
        }
        for (r, row) in rows.iter().enumerate() {
            let r = r as u32 + 1;
            for (c, cell) in row.iter().enumerate() {
                let c = c as u16;
                match cell {
                    Cell::Text(s) if s.is_empty() => {}
                    Cell::Text(s) => { ws.write_string(r, c, s).map_err(e)?; }
                    Cell::Money(v) => { ws.write_number_with_format(r, c, *v, &money).map_err(e)?; }
                    Cell::Num(v) => { ws.write_number(r, c, *v).map_err(e)?; }
                }
            }
        }
        ws.set_freeze_panes(1, 0).map_err(e)?;
        ws.autofilter(0, 0, rows.len() as u32, headers.len() as u16 - 1).map_err(e)?;
    }
    let bytes = wb.save_to_buffer().map_err(|x| format!("could not write the workbook: {x}"))?;
    Ok((bytes, rec.deals.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE invoices (id TEXT PRIMARY KEY, client_id TEXT, number TEXT, issue_date TEXT, sent_at TEXT,
               line_items_json TEXT, total REAL, voided INTEGER DEFAULT 0, archived INTEGER DEFAULT 0);
             CREATE TABLE deal_flows (id TEXT PRIMARY KEY, org_id TEXT DEFAULT 'org_default', invoice_id TEXT, name TEXT,
               stage TEXT, category TEXT, brand TEXT, created_at TEXT, payment_received_at TEXT, payment_received_amount REAL,
               payment_received_method TEXT, deposit_amount REAL, completed_at TEXT, pickup_date TEXT,
               expected_delivery_date TEXT, gross_revenue REAL, total_cost REAL, net_profit REAL, archived INTEGER DEFAULT 0,
               supplier_payments_json TEXT, notes TEXT);
             CREATE TABLE bank_txn (id TEXT PRIMARY KEY, posted_at TEXT, direction TEXT, amount REAL, description TEXT,
               counterparty_name TEXT, account_id TEXT);
             CREATE TABLE bank_allocation (id TEXT PRIMARY KEY, bank_txn_id TEXT, deal_flow_id TEXT, amount REAL, role TEXT, note TEXT);
             CREATE TABLE refunds (id TEXT PRIMARY KEY, deal_flow_id TEXT, amount REAL, method TEXT, reason TEXT,
               refunded_at TEXT, created_at TEXT, bank_txn_id TEXT);
             CREATE TABLE freight_bookings (id TEXT PRIMARY KEY, deal_flow_id TEXT, load_number TEXT, carrier TEXT, status TEXT,
               quoted_cost REAL, paid_amount REAL, paid_at TEXT, paid_method TEXT, paid_note TEXT, archived INTEGER DEFAULT 0);

             INSERT INTO clients VALUES ('c1','Acme Resale');
             INSERT INTO invoices VALUES ('i1','c1','INV-0100','2026-06-02','2026-06-02T15:00:00Z',
               '[{\"description\":\"Mixed apparel pallet\",\"qty\":4,\"rate\":2500,\"amount\":10000}]',10000,0,0);
             INSERT INTO invoices VALUES ('i2','c1','INV-0101','2026-06-10',NULL,'[]',5000,1,0);
             INSERT INTO deal_flows VALUES ('d1','org_default','i1','June apparel','complete','Apparel','',
               '2026-06-01T12:00:00Z','2026-07-01T02:30:00Z',10000,'wire',0,'2026-06-30','2026-06-05','2026-06-09',
               10000,7000,3000,0,
               '[{\"id\":\"s1\",\"supplier_name\":\"North Supply\",\"amount\":6500,\"paid\":true,\"paid_at\":\"2026-06-03\"},
                 {\"id\":\"s2\",\"supplier_name\":\"Quick Freight\",\"amount\":500,\"paid\":false,\"category\":\"freight\"}]','');
             INSERT INTO deal_flows VALUES ('d1b','org_default','i1','June apparel copy','complete','','',
               '2026-06-01T12:00:00Z','',0,'',0,'2026-06-30','','',10000,7000,3000,0,'[]','');
             INSERT INTO deal_flows VALUES ('d2','org_default','i2','Fell through','complete','','',
               '2026-06-10T12:00:00Z','',0,'',0,'2026-06-20','','',5000,4000,1000,0,'[]','');
             INSERT INTO deal_flows VALUES ('d3','other_org','i1','Not ours','invoiced','','',
               '2026-06-10T12:00:00Z','',0,'',0,'','','',0,0,0,0,'[]','');
             INSERT INTO bank_txn VALUES ('b1','2026-06-30','in',10000,'FEDWIRE CREDIT ACME','Acme Resale','Chase 3655');
             INSERT INTO bank_txn VALUES ('b2','2026-07-02','out',200,'ZELLE TO ACME','Acme Resale','Chase 3655');
             INSERT INTO bank_allocation VALUES ('a1','b1','d1',10000,'buyer_payment','');
             INSERT INTO bank_allocation VALUES ('a2','b2','d1',200,'refund_out','');
             INSERT INTO refunds VALUES ('r1','d1',150,'cash','two units short','2026-07-05','2026-07-05T10:00:00Z','');
             INSERT INTO freight_bookings VALUES ('f1','d1','LD-0007','Road Co','delivered',450,480,'2026-06-12','ach','',0);
             INSERT INTO freight_bookings VALUES ('f2','d1','LD-0008','Road Co','quote',300,NULL,'','','',0);",
        ).unwrap();
        c
    }

    fn col(headers: &[(&str, f64)], name: &str) -> usize {
        headers.iter().position(|(h, _)| *h == name).unwrap()
    }

    #[test]
    fn rows_match_their_headers() {
        let r = collect(&db(), "").unwrap();
        assert!(r.deals.iter().all(|row| row.len() == DEAL_HEADERS.len()));
        assert!(r.items.iter().all(|row| row.len() == ITEM_HEADERS.len()));
        assert!(r.money.iter().all(|row| row.len() == MONEY_HEADERS.len()));
    }

    #[test]
    fn counted_in_profit_follows_the_month_profit_rule() {
        let r = collect(&db(), "org_default").unwrap();
        let k = col(DEAL_HEADERS, "Counted in profit");
        let m = col(DEAL_HEADERS, "Profit month");
        let by_deal = |name: &str| r.deals.iter().find(|d| d[1] == t(name)).unwrap().clone();
        assert_eq!(by_deal("June apparel")[k], t("Yes"));
        assert_eq!(by_deal("June apparel")[m], t("2026-06"));
        assert_eq!(by_deal("June apparel copy")[k], t("No: another deal on this invoice is counted"));
        assert_eq!(by_deal("Fell through")[k], t("No: fell through"));
        assert_eq!(by_deal("Fell through")[m], t(""));
        assert!(r.deals.iter().all(|d| d[1] != t("Not ours")), "another org's deal leaked into the file");
    }

    #[test]
    fn refunds_are_counted_once_and_come_off_profit() {
        let r = collect(&db(), "").unwrap();
        let d = r.deals.iter().find(|d| d[1] == t("June apparel")).unwrap();
        // 150 typed with no bank row + 200 linked as refund_out.
        assert_eq!(d[col(DEAL_HEADERS, "Refunds")], Cell::Money(350.0));
        assert_eq!(d[col(DEAL_HEADERS, "Profit after refunds")], Cell::Money(2650.0));
        assert_eq!(d[col(DEAL_HEADERS, "Supplier")], t("North Supply"));
        assert_eq!(d[col(DEAL_HEADERS, "Suppliers paid")], t("2026-06-03"));
        assert_eq!(d[col(DEAL_HEADERS, "Loads")], t("LD-0007"));
        // An instant is read as its Central day: 02:30 UTC on Jul 1 is the evening of Jun 30.
        assert_eq!(d[col(DEAL_HEADERS, "Buyer paid")], t("2026-06-30"));
    }

    #[test]
    fn money_lists_every_movement_oldest_first_with_unpaid_last() {
        let r = collect(&db(), "").unwrap();
        let rows: Vec<&Vec<Cell>> = r.money.iter().filter(|m| m[1] == t("June apparel")).collect();
        let what: Vec<Cell> = rows.iter().map(|m| m[col(MONEY_HEADERS, "What")].clone()).collect();
        assert_eq!(what, vec![
            t("Supplier cost"), t("Carrier pay"), t("Buyer payment (entered on the deal)"), t("Bank: buyer payment"),
            t("Bank: refund paid"), t("Refund"), t("Freight"),
        ]);
        // The quote-stage load is not carrier pay.
        assert_eq!(rows.iter().filter(|m| m[col(MONEY_HEADERS, "What")] == t("Carrier pay")).count(), 1);
        assert_eq!(rows.last().unwrap()[col(MONEY_HEADERS, "Status")], t("Unpaid"));
        let items: Vec<&Vec<Cell>> = r.items.iter().filter(|m| m[1] == t("June apparel")).collect();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0][col(ITEM_HEADERS, "Amount")], Cell::Money(10000.0));
    }

    #[test]
    fn workbook_writes() {
        let (bytes, deals) = workbook(&db(), "").unwrap();
        assert!(bytes.starts_with(b"PK"), "an .xlsx is a zip");
        assert_eq!(deals, 4);
    }
}
