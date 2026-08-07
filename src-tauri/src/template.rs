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
    let (actual_paid, invoices_sent): (f64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END),0),
                COUNT(CASE WHEN status IN ('sent','paid') THEN 1 END)
         FROM invoices WHERE client_id=?1",
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

    // Keep in lockstep with commands.rs `tier_for` (Platinum > Diamond > Gold > Silver > Bronze).
    let tier = if actual_paid > 150000.0 || effective_annual > 250000.0 || deals_landed >= 25 { "P" }
    else if actual_paid > 60000.0 || effective_annual > 120000.0 || deals_landed >= 12 { "S" }
    else if actual_paid > 25000.0 || effective_annual > 60000.0 || deals_landed >= 6 { "A" }
    else if actual_paid > 8000.0 || effective_annual > 20000.0 || deals_landed >= 3 { "B" }
    else if effective_annual > 0.0 || actual_paid > 0.0 || invoices_sent >= 1 { "C" }
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
            let days: i64 = conn.query_row(
                "SELECT CAST(JULIANDAY('now') - JULIANDAY(due_date) AS INTEGER) FROM invoices WHERE client_id=?1 AND status='overdue' ORDER BY due_date DESC LIMIT 1",
                [client_id],
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
