use rusqlite::Connection;
use serde_json::Value;
use regex::Regex;

fn format_currency(v: f64) -> String {
    let s = format!("{:.2}", v);
    let parts: Vec<&str> = s.split('.').collect();
    let int_part = parts[0];
    let dec_part = parts.get(1).unwrap_or(&"00");
    let negative = int_part.starts_with('-');
    let digits = if negative { &int_part[1..] } else { int_part };
    let mut grouped = String::new();
    for (i, c) in digits.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 { grouped.insert(0, ','); }
        grouped.insert(0, c);
    }
    let sign = if negative { "-" } else { "" };
    format!("${}{}.{}", sign, grouped, dec_part)
}

fn first_name_of(name: &str) -> String {
    name.split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

fn tier_label(s: &str) -> &str {
    match s {
        "P" => "Platinum",
        "S" => "Diamond",
        "A" => "Gold",
        "B" => "Silver",
        "C" => "Bronze",
        _ => "Prospect",
    }
}

fn compute_tier(conn: &Connection, client_id: &str, metadata_str: Option<&str>) -> String {
    // The invoice figures feeding the ladder, filtered exactly like `buyer_tiers` in
    // commands.rs — the comparator every screen already agrees with. Two guards, both
    // load-bearing, both missing here until 2026-08-31:
    //  * voided and archived invoices are excluded. A cancelled invoice is not money:
    //    a $6,515 voided invoice was holding a live buyer a full tier above what every
    //    screen showed him, and the merge field printed that tier into his email.
    //  * 'overdue' counts as SENT — going overdue cannot erase the fact an invoice was
    //    sent, and dropping it demoted a client with one live overdue to Prospect.
    let (actual_paid, invoices_sent): (f64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END),0),
                COUNT(CASE WHEN status IN ('sent','overdue','paid') THEN 1 END)
         FROM invoices WHERE client_id=?1 AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0",
        [client_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap_or((0.0, 0));

    // Net refunds off the paid figure before it reaches the ladder — the counted-once
    // rule, same as `refunded_by_client` in commands.rs. Without this a merge field could
    // render "Diamond" for a buyer every screen calls Gold (2026-08-07).
    let refunded: f64 = conn.query_row(
        "SELECT COALESCE(SUM(x.amt),0) FROM ( \
            SELECT r.amount AS amt, r.deal_flow_id AS dfid FROM refunds r WHERE COALESCE(r.bank_txn_id,'')='' \
            UNION ALL \
            SELECT a.amount, a.deal_flow_id FROM bank_allocation a WHERE a.role='refund_out' \
              AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id) \
         ) x JOIN deal_flows df ON df.id=x.dfid JOIN invoices iv ON iv.id=df.invoice_id \
         WHERE iv.client_id=?1",
        [client_id], |r| r.get(0),
    ).unwrap_or(0.0);
    let actual_paid = (actual_paid - refunded).max(0.0);

    let meta: Option<Value> = metadata_str.and_then(|s| serde_json::from_str(s).ok());
    let frequency = meta.as_ref().and_then(|m| m.get("purchase_frequency")).and_then(|v| v.as_str());
    let spend_raw = meta.as_ref().and_then(|m| m.get("estimated_annual_spend")).and_then(|v| v.as_str()).unwrap_or("0");
    let annual_spend: f64 = spend_raw.parse().unwrap_or(0.0);
    let freq_mult = match frequency.unwrap_or("").to_lowercase().as_str() {
        "weekly" => 52.0, "bi-weekly" => 26.0, "monthly" => 12.0,
        "quarterly" => 4.0, "annually" => 1.0, _ => 0.0,
    };
    let effective_annual = freq_mult * annual_spend;

    // Deals landed (completed deals, distinct by invoice) — a tier factor.
    let deals_landed: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT df.invoice_id) FROM deal_flows df JOIN invoices iv ON iv.id=df.invoice_id \
         WHERE iv.client_id=?1 AND df.stage='complete' AND COALESCE(df.archived,0)=0 \
           AND COALESCE(iv.archived,0)=0 AND COALESCE(iv.voided,0)=0",
        [client_id], |r| r.get(0),
    ).unwrap_or(0);

    // A quote is engagement too, the same as in `tier_for`: a client who has only ever
    // been quoted is Bronze on every screen, and the merge field said Prospect.
    let quotes_sent: i64 = conn.query_row(
        "SELECT COUNT(*) FROM quotes WHERE client_id=?1 AND status IN ('sent','accepted','declined','expired')",
        [client_id], |r| r.get(0),
    ).unwrap_or(0);

    // Keep in lockstep with commands.rs `tier_for` (Platinum > Diamond > Gold > Silver > Bronze).
    let tier = if actual_paid > 150000.0 || effective_annual > 250000.0 || deals_landed >= 25 { "P" }
    else if actual_paid > 60000.0 || effective_annual > 120000.0 || deals_landed >= 12 { "S" }
    else if actual_paid > 25000.0 || effective_annual > 60000.0 || deals_landed >= 6 { "A" }
    else if actual_paid > 8000.0 || effective_annual > 20000.0 || deals_landed >= 3 { "B" }
    else if effective_annual > 0.0 || actual_paid > 0.0 || invoices_sent >= 1 || quotes_sent >= 1 { "C" }
    else { "Prospect" };

    tier_label(tier).to_string()
}

struct ClientInfo {
    name: Option<String>,
    company: Option<String>,
    metadata: Option<String>,
}


fn resolve_variable(token: &str, info: &ClientInfo, conn: &Connection, client_id: &str) -> Option<String> {
    match token {
        "first_name" => {
            let name = info.name.as_deref()?;
            let first = first_name_of(name);
            if first.is_empty() { None } else { Some(first) }
        }
        "full_name" => info.name.clone(),
        "company" => info.company.clone().filter(|s| !s.is_empty()),
        "city" => {
            let meta: Option<Value> = info.metadata.as_deref().and_then(|s| serde_json::from_str(s).ok());
            meta.as_ref()
                .and_then(|m| m.get("city"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        }
        "invoice_number" => {
            conn.query_row(
                "SELECT number FROM invoices WHERE client_id=?1 ORDER BY issue_date DESC LIMIT 1",
                [client_id],
                |r| r.get::<_,String>(0),
            ).ok()
        }
        "amount_due" => {
            let total: f64 = conn.query_row(
                "SELECT total FROM invoices WHERE client_id=?1 AND status IN ('sent','overdue') ORDER BY issue_date DESC LIMIT 1",
                [client_id],
                |r| r.get(0),
            ).ok()?;
            let formatted = format_currency(total);
            Some(formatted)
        }
        "due_date" => {
            conn.query_row(
                "SELECT due_date FROM invoices WHERE client_id=?1 AND status IN ('sent','overdue') ORDER BY issue_date DESC LIMIT 1",
                [client_id],
                |r| r.get::<_,String>(0),
            ).ok()
        }
        "days_overdue" => {
            // R-159: `JULIANDAY('now')` is UTC, which is already tomorrow from 6pm
            // Central — this number is printed in dunning email, so from every evening
            // onward it told the customer they were a day later than they were. Anchor
            // it on the Central date like the overdue sweep in commands.rs.
            let today = crate::commands::central_today().format("%Y-%m-%d").to_string();
            let days: i64 = conn.query_row(
                "SELECT CAST(JULIANDAY(?2) - JULIANDAY(due_date) AS INTEGER) FROM invoices WHERE client_id=?1 AND status='overdue' ORDER BY due_date DESC LIMIT 1",
                rusqlite::params![client_id, today],
                |r| r.get(0),
            ).ok()?;
            if days > 0 { Some(days.to_string()) } else { None }
        }
        "last_order_date" => {
            conn.query_row(
                "SELECT issue_date FROM invoices WHERE client_id=?1 AND status='paid' ORDER BY issue_date DESC LIMIT 1",
                [client_id],
                |r| r.get::<_,String>(0),
            ).ok()
        }
        "tier" => {
            Some(compute_tier(conn, client_id, info.metadata.as_deref()))
        }
        _ => None,
    }
}

pub fn substitute_variables(template: &str, client_id: &str, conn: &Connection) -> String {
    let info = ClientInfo {
        name: conn.query_row("SELECT name FROM clients WHERE id=?1", [client_id], |r| r.get(0)).ok(),
        company: conn.query_row("SELECT company FROM clients WHERE id=?1", [client_id], |r| r.get(0)).ok(),
        metadata: conn.query_row("SELECT metadata FROM clients WHERE id=?1", [client_id], |r| r.get(0)).ok(),
    };

    let re = Regex::new(r"\{\{?([a-z_]+)\}\}?").unwrap();
    re.replace_all(template, |caps: &regex::Captures| {
        let token = &caps[1];
        match resolve_variable(token, &info, conn, client_id) {
            Some(val) => val,
            None => caps[0].to_string(),
        }
    }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The columns `compute_tier` and the `days_overdue` resolver actually read.
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT, company TEXT, metadata TEXT);
             CREATE TABLE invoices (id TEXT PRIMARY KEY, client_id TEXT, number TEXT, status TEXT,
                total REAL NOT NULL DEFAULT 0, issue_date TEXT, due_date TEXT,
                voided INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE quotes (id TEXT PRIMARY KEY, client_id TEXT, status TEXT);
             CREATE TABLE deal_flows (id TEXT PRIMARY KEY, invoice_id TEXT, stage TEXT,
                archived INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE refunds (id TEXT PRIMARY KEY, deal_flow_id TEXT, amount REAL,
                bank_txn_id TEXT);
             CREATE TABLE bank_allocation (id TEXT PRIMARY KEY, bank_txn_id TEXT,
                deal_flow_id TEXT, amount REAL, role TEXT);
             CREATE TABLE bank_txn (id TEXT PRIMARY KEY);
             INSERT INTO clients (id, name) VALUES ('c1', 'A Buyer');",
        )
        .unwrap();
        conn
    }

    fn invoice(conn: &Connection, id: &str, status: &str, total: f64, voided: i64, archived: i64) {
        conn.execute(
            "INSERT INTO invoices (id, client_id, status, total, issue_date, due_date, voided, archived)
             VALUES (?1,'c1',?2,?3,'2026-01-01','2026-01-31',?4,?5)",
            rusqlite::params![id, status, total, voided, archived],
        )
        .unwrap();
    }

    #[test]
    fn a_voided_invoice_cannot_hold_a_tier() {
        // The live case this fixed: $6,515 voided plus $5,330 real read as $11,845 and
        // printed "Silver" into the buyer's email, one tier above every screen.
        let conn = fixture();
        invoice(&conn, "i1", "paid", 6515.0, 1, 0);
        invoice(&conn, "i2", "paid", 5330.0, 0, 0);
        assert_eq!(compute_tier(&conn, "c1", None), "Bronze");
        // An archived invoice is out for the same reason.
        invoice(&conn, "i3", "paid", 40000.0, 0, 1);
        assert_eq!(compute_tier(&conn, "c1", None), "Bronze");
    }

    #[test]
    fn an_overdue_invoice_still_counts_as_sent() {
        // Going overdue cannot erase the fact an invoice was sent. Counting only
        // sent/paid called a client with one live overdue invoice a Prospect.
        let conn = fixture();
        invoice(&conn, "i1", "overdue", 2.0, 0, 0);
        assert_eq!(compute_tier(&conn, "c1", None), "Bronze");
    }

    #[test]
    fn a_quote_on_its_own_earns_bronze() {
        // `tier_for` gives any real engagement Bronze, a quote included, so the merge
        // field must too or the email contradicts the screen that sent it.
        let conn = fixture();
        conn.execute("INSERT INTO quotes VALUES ('q1','c1','sent')", []).unwrap();
        assert_eq!(compute_tier(&conn, "c1", None), "Bronze");
        // And a client with nothing at all is still a Prospect.
        conn.execute("DELETE FROM quotes", []).unwrap();
        assert_eq!(compute_tier(&conn, "c1", None), "Prospect");
    }

    #[test]
    fn deals_landed_ignores_archived_deals_and_dead_invoices() {
        // Twelve completed deals is Diamond — but only ones that still count.
        let conn = fixture();
        for n in 0..12 {
            invoice(&conn, &format!("i{n}"), "paid", 1.0, 0, i64::from(n < 6));
            conn.execute(
                "INSERT INTO deal_flows VALUES (?1, ?2, 'complete', ?3)",
                rusqlite::params![format!("d{n}"), format!("i{n}"), i64::from(n >= 9)],
            )
            .unwrap();
        }
        // Six archived invoices and three archived deals leave three landed, not twelve.
        assert_eq!(compute_tier(&conn, "c1", None), "Silver");
    }

    #[test]
    fn days_overdue_counts_from_the_central_date() {
        // The number printed in dunning email. `JULIANDAY('now')` is UTC, already
        // tomorrow from 6pm Central, so it read a day high every evening.
        let conn = fixture();
        let due = crate::commands::central_today() - chrono::Duration::days(10);
        conn.execute(
            "INSERT INTO invoices (id, client_id, status, total, issue_date, due_date)
             VALUES ('i1','c1','overdue',100,'2026-01-01',?1)",
            [due.format("%Y-%m-%d").to_string()],
        )
        .unwrap();
        let info = ClientInfo { name: None, company: None, metadata: None };
        assert_eq!(
            resolve_variable("days_overdue", &info, &conn, "c1"),
            Some("10".to_string())
        );
    }
}
