//! Chase bank-statement importer for the financial/treasury engine.
//!
//! Two input formats, auto-detected:
//!   - OFX / QBO / QFX (PREFERRED): carries a stable per-txn `<FITID>` that is the
//!     only reliable dedupe key Chase exposes. OFX 1.x is SGML (element tags are
//!     unclosed), so we use a tolerant tag scanner, not an XML parser.
//!   - CSV (best-effort): Chase business CSV has NO transaction id, so we dedupe on
//!     a synthesized fingerprint (date+amount+description+check#), which can collide
//!     for identical same-day rows — flagged to the user.
//!
//! Rows are written to the immutable `bank_txn` table with a DETERMINISTIC id derived
//! from the dedupe key, so re-importing the same statement (on either device) lands
//! the same id and naturally de-duplicates through sync. We never UPDATE a bank_txn.
//!
//! Classification is auto-suggested (rail / direction / category / counterparty) but
//! NEVER auto-allocated — allocation to deals is a separate, human-confirmed step.

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ParsedRow {
    pub posted_at: String, // YYYY-MM-DD
    pub amount: f64,       // absolute value (always positive)
    pub direction: String, // "in" | "out"
    pub description: String,
    pub memo_raw: String,
    pub rail: String,     // wire | ach | zelle | cash | card | rtp | ""
    pub category: String, // coarse auto-class (see classify)
    pub counterparty_name: String,
    pub fitid: String,
    pub wire_ref: String, // IMAD / TRN / Trace# extracted from memo
    pub check_num: String,
    pub balance: f64,
}

#[derive(Debug, Serialize)]
pub struct BankPreview {
    pub format: String, // "ofx" | "csv"
    pub total: usize,
    pub has_fitid: bool, // true when a reliable dedupe key is present (OFX)
    pub sample: Vec<ParsedRow>,
}

#[derive(Debug, Serialize)]
pub struct BankImportSummary {
    pub imported: usize,
    pub skipped: usize, // already present (dedupe)
    pub errors: Vec<String>,
    pub format: String,
    pub has_fitid: bool,
}

/// Detect OFX vs CSV by content sniff (OFX headers / <OFX> tag), else CSV.
fn is_ofx(text: &str) -> bool {
    let head = &text[..text.len().min(4096)];
    head.contains("OFXHEADER") || head.contains("<OFX>") || head.contains("<STMTTRN>")
}

/// Read a file tolerant of non-UTF8 (Chase exports are occasionally Windows-1252).
fn read_text(path: &str) -> Result<String> {
    let bytes = std::fs::read(path).context("read file")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ── OFX (SGML) ──────────────────────────────────────────────────────────────

/// Value of an OFX element: text after `<TAG>` up to the next `<` (SGML style),
/// tolerating both unclosed (1.x) and closed (2.x) tags.
fn ofx_tag(block: &str, tag: &str) -> String {
    let needle = format!("<{}>", tag);
    if let Some(p) = block.find(&needle) {
        let rest = &block[p + needle.len()..];
        let end = rest.find('<').unwrap_or(rest.len());
        return rest[..end].trim().to_string();
    }
    String::new()
}

/// OFX DTPOSTED `20240604120000[-5:EST]` / `20240604` → `2024-06-04`.
fn ofx_date(raw: &str) -> String {
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 {
        format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8])
    } else {
        String::new()
    }
}

fn parse_ofx(text: &str) -> Vec<ParsedRow> {
    let mut out = Vec::new();
    // Aggregates ARE closed in OFX SGML, so split on the STMTTRN wrapper.
    for chunk in text.split("<STMTTRN>").skip(1) {
        let block = chunk.split("</STMTTRN>").next().unwrap_or(chunk);
        let amt: f64 = ofx_tag(block, "TRNAMT").replace(',', "").parse().unwrap_or(0.0);
        let name = ofx_tag(block, "NAME");
        let memo = ofx_tag(block, "MEMO");
        let mut description = name.clone();
        if !memo.is_empty() {
            if description.is_empty() { description = memo.clone(); }
            else { description = format!("{} {}", name, memo); }
        }
        let mut row = ParsedRow {
            posted_at: ofx_date(&ofx_tag(block, "DTPOSTED")),
            amount: amt.abs(),
            direction: if amt < 0.0 { "out".into() } else { "in".into() },
            description: description.clone(),
            memo_raw: description,
            rail: String::new(),
            category: String::new(),
            counterparty_name: String::new(),
            fitid: ofx_tag(block, "FITID"),
            wire_ref: String::new(),
            check_num: ofx_tag(block, "CHECKNUM"),
            balance: 0.0,
        };
        classify(&mut row, &ofx_tag(block, "TRNTYPE"));
        out.push(row);
    }
    out
}

// ── CSV (Chase business) ────────────────────────────────────────────────────

/// Find a column index by case-insensitive exact-then-substring match.
fn find_col(headers: &[String], candidates: &[&str]) -> Option<usize> {
    let lower: Vec<String> = headers.iter().map(|h| h.trim().to_lowercase()).collect();
    for c in candidates {
        let cl = c.to_lowercase();
        if let Some(i) = lower.iter().position(|h| *h == cl) { return Some(i); }
    }
    for c in candidates {
        let cl = c.to_lowercase();
        if let Some(i) = lower.iter().position(|h| h.contains(&cl)) { return Some(i); }
    }
    None
}

/// Chase CSV date `06/04/2024` (or `6/4/2024`) → `2024-06-04`.
fn csv_date(raw: &str) -> String {
    let parts: Vec<&str> = raw.trim().split('/').collect();
    if parts.len() == 3 {
        let (m, d, y) = (parts[0], parts[1], parts[2]);
        if let (Ok(m), Ok(d)) = (m.parse::<u32>(), d.parse::<u32>()) {
            let y = if y.len() == 2 { format!("20{}", y) } else { y.to_string() };
            return format!("{}-{:02}-{:02}", y, m, d);
        }
    }
    raw.trim().to_string()
}

fn parse_csv(path: &str) -> Result<Vec<ParsedRow>> {
    let mut rdr = csv::Reader::from_path(path).context("open csv")?;
    let headers: Vec<String> = rdr.headers()?.iter().map(|s| s.trim().to_string()).collect();
    let i_date = find_col(&headers, &["Posting Date", "Post Date", "Date"]);
    let i_desc = find_col(&headers, &["Description"]);
    let i_amt = find_col(&headers, &["Amount"]);
    let i_type = find_col(&headers, &["Type", "Details"]);
    let i_bal = find_col(&headers, &["Balance"]);
    let i_chk = find_col(&headers, &["Check or Slip #", "Check"]);

    let mut out = Vec::new();
    for rec in rdr.records() {
        let rec = match rec { Ok(r) => r, Err(_) => continue };
        let get = |idx: Option<usize>| idx.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string();
        let amt: f64 = get(i_amt).replace(['$', ','], "").parse().unwrap_or(0.0);
        let desc = get(i_desc);
        if desc.is_empty() && amt == 0.0 { continue; }
        let mut row = ParsedRow {
            posted_at: csv_date(&get(i_date)),
            amount: amt.abs(),
            direction: if amt < 0.0 { "out".into() } else { "in".into() },
            description: desc.clone(),
            memo_raw: desc,
            rail: String::new(),
            category: String::new(),
            counterparty_name: String::new(),
            fitid: String::new(),
            wire_ref: String::new(),
            check_num: get(i_chk),
            balance: get(i_bal).replace(['$', ','], "").parse().unwrap_or(0.0),
        };
        classify(&mut row, &get(i_type));
        out.push(row);
    }
    Ok(out)
}

// ── Auto-classify (spec §3) ─────────────────────────────────────────────────

/// Extract the text after a `needle` up to end-of-line / next delimiter.
fn after(hay: &str, needle: &str) -> String {
    hay.find(needle)
        .map(|p| &hay[p + needle.len()..])
        .map(|r| r.split(['\n', '<']).next().unwrap_or(r).trim().to_string())
        .unwrap_or_default()
}

/// Fill rail / category / counterparty_name / wire_ref from the raw text. This is a
/// SUGGESTION only — the review queue lets a human correct it, and nothing is
/// allocated to a deal automatically.
fn classify(row: &mut ParsedRow, txn_type: &str) {
    let hay = format!("{} {}", row.description, txn_type).to_uppercase();
    let inbound = row.direction == "in";

    // Rail
    row.rail = if hay.contains("WIRE") || hay.contains("FEDWIRE") || hay.contains("CHIPS") || hay.contains("BOOK TRANSFER") {
        "wire"
    } else if hay.contains("ZELLE") || hay.contains("QUICKPAY") {
        "zelle"
    } else if hay.contains("REAL TIME") || hay.contains("RTP") {
        "rtp"
    } else if hay.contains("ATM") || hay.contains("CASH") || hay.contains("TELLER") || hay.contains("WITHDRAWAL") {
        "cash"
    } else if hay.contains("CARD") || hay.contains("PURCHASE") {
        "card"
    } else if hay.contains("ACH") || hay.contains("ORIG CO NAME") || hay.contains("PPD") || hay.contains("CCD") {
        "ach"
    } else {
        ""
    }.to_string();

    // Coarse category (feeds the review queue + expense/owner-draw routing).
    let up = hay.as_str();
    row.category = if up.contains("WIRE FEE") || up.contains("SERVICE FEE") || up.contains("MONTHLY SERVICE") {
        "fee"
    } else if up.contains("CHASE CARD") || up.contains("AMERICAN EXPRESS") || up.contains("AMEX") || up.contains("EARNEST") {
        "owner_draw"
    } else if up.contains("PIRATE SHIP") || up.contains("SHIPSTATION") || up.contains("USPS") || up.contains("UPS") || up.contains("FEDEX") {
        "shipping"
    } else if up.contains("AIRTABLE") || up.contains("SHOPIFY") || up.contains("ANTHROPIC") || up.contains("GOOGLE") || up.contains("GODADDY") || up.contains("SOFTWARE") {
        "software"
    } else if up.contains("TRANSFER TO CHK") || up.contains("TRANSFER FROM CHK") || up.contains("TRANSFER TO MMA") || up.contains("TRANSFER FROM MMA") || up.contains("MMA ") {
        "internal_transfer"
    } else if row.rail == "cash" {
        if inbound { "cash_in" } else { "cash_out" }
    } else if inbound {
        "receipt" // money in from a buyer/retail — allocate to a deal
    } else {
        "payment" // money out to a supplier/vendor — allocate or expense
    }.to_string();

    // Counterparty originator (best-effort from free text).
    for needle in ["B/O:", "B/O ", "A/C:", "A/C ", "ORIG CO NAME:", "PAYMENT TO ", "PAYMENT FROM ", "FROM: ", "TO "] {
        // Search case-insensitively by scanning the original-cased description.
        if let Some(idx) = row.description.to_uppercase().find(needle) {
            let raw = &row.description[idx + needle.len()..];
            let val = raw.split(['\n']).next().unwrap_or(raw).trim();
            // Strip a leading account-number token like "1/" seen in CHIPS memos.
            let val = val.trim_start_matches(|c: char| c.is_ascii_digit() || c == '/').trim();
            if val.len() >= 2 {
                row.counterparty_name = val.chars().take(60).collect();
                break;
            }
        }
    }

    // Wire reference (IMAD / TRN / Trace#).
    let up_desc = row.description.to_uppercase();
    for key in ["IMAD:", "IMAD ", "TRN:", "TRN ", "TRACE#", "TRACE #", "TRACE:"] {
        let v = after(&up_desc, key);
        let v: String = v.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if v.len() >= 4 {
            row.wire_ref = v;
            break;
        }
    }
}

// ── Public API: preview + import ────────────────────────────────────────────

pub fn preview(path: &str) -> Result<BankPreview> {
    let text = read_text(path)?;
    let (format, rows) = if is_ofx(&text) {
        ("ofx".to_string(), parse_ofx(&text))
    } else {
        ("csv".to_string(), parse_csv(path)?)
    };
    let has_fitid = rows.iter().any(|r| !r.fitid.is_empty());
    Ok(BankPreview {
        format,
        total: rows.len(),
        has_fitid,
        sample: rows.into_iter().take(8).collect(),
    })
}

/// 64-bit FNV-1a — deterministic across runs/platforms (no external dep), so the
/// same statement imported on the PC and the MacBook produces identical ids.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn stable_id(account_id: &str, row: &ParsedRow) -> String {
    let key = if !row.fitid.is_empty() {
        format!("{}|{}", account_id, row.fitid)
    } else {
        // CSV fallback fingerprint — best-effort, may collide for identical same-day rows.
        format!(
            "{}|{}|{:.2}|{}|{}|{}",
            account_id, row.posted_at, row.amount, row.direction,
            row.description.to_lowercase(), row.check_num
        )
    };
    format!("bt_{:016x}", fnv1a(&key))
}

pub fn import(path: &str, account_id: &str) -> Result<BankImportSummary> {
    let text = read_text(path)?;
    let (format, rows) = if is_ofx(&text) {
        ("ofx".to_string(), parse_ofx(&text))
    } else {
        ("csv".to_string(), parse_csv(path)?)
    };
    let has_fitid = rows.iter().any(|r| !r.fitid.is_empty());
    let now = chrono::Utc::now().to_rfc3339();
    let conn = crate::db::pool().get().context("db pool")?;

    let mut summary = BankImportSummary {
        imported: 0, skipped: 0, errors: Vec::new(),
        format, has_fitid,
    };

    for row in &rows {
        let id = stable_id(account_id, row);
        // Immutable + deduped: if this exact txn already landed, skip (no re-emit).
        let exists: bool = conn
            .query_row("SELECT 1 FROM bank_txn WHERE id=?1", [&id], |_| Ok(()))
            .is_ok();
        if exists {
            summary.skipped += 1;
            continue;
        }

        let mut cols = serde_json::Map::new();
        let s = |v: &str| serde_json::Value::String(v.to_string());
        cols.insert("account_id".into(), s(account_id));
        cols.insert("posted_at".into(), s(&row.posted_at));
        cols.insert("amount".into(), serde_json::json!(row.amount));
        cols.insert("direction".into(), s(&row.direction));
        cols.insert("description".into(), s(&row.description));
        cols.insert("memo_raw".into(), s(&row.memo_raw));
        cols.insert("rail".into(), s(&row.rail));
        cols.insert("category".into(), s(&row.category));
        cols.insert("counterparty_name".into(), s(&row.counterparty_name));
        cols.insert("fitid".into(), s(&row.fitid));
        cols.insert("wire_ref".into(), s(&row.wire_ref));
        cols.insert("check_num".into(), s(&row.check_num));
        cols.insert("balance".into(), serde_json::json!(row.balance));
        cols.insert("source_format".into(), s(&summary.format));
        cols.insert("imported_at".into(), s(&now));
        cols.insert("created_at".into(), s(&now));
        cols.insert("updated_at".into(), s(&now));

        if let Err(e) = crate::sync::record_upsert("bank_txn", &id, cols) {
            summary.errors.push(format!("{}: sync record failed: {}", row.posted_at, e));
            continue;
        }
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO bank_txn
               (id, account_id, posted_at, amount, direction, description, memo_raw, rail,
                category, counterparty_name, fitid, wire_ref, check_num, balance,
                source_format, imported_at, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16,?16)",
            rusqlite::params![
                id, account_id, row.posted_at, row.amount, row.direction, row.description,
                row.memo_raw, row.rail, row.category, row.counterparty_name, row.fitid,
                row.wire_ref, row.check_num, row.balance, summary.format, now
            ],
        ) {
            summary.errors.push(format!("{}: db insert: {}", row.posted_at, e));
            continue;
        }
        summary.imported += 1;
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_OFX: &str = "OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><BANKTRANLIST>\
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240604120000[-5:EST]<TRNAMT>15000.00<FITID>2024ABC<NAME>Fedwire Credit<MEMO>B/O: LAST STOCK LLC</STMTTRN>\
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240605<TRNAMT>-2500.00<FITID>2024DEF<NAME>Zelle Payment To NJH SUPPLY<MEMO></STMTTRN>\
</BANKTRANLIST></STMTTRNRS></BANKMSGSRSV1></OFX>";

    #[test]
    fn parses_ofx_wire_and_zelle() {
        let rows = parse_ofx(SAMPLE_OFX);
        assert_eq!(rows.len(), 2);

        let a = &rows[0];
        assert_eq!(a.posted_at, "2024-06-04");
        assert_eq!(a.amount, 15000.0);
        assert_eq!(a.direction, "in");
        assert_eq!(a.fitid, "2024ABC");
        assert_eq!(a.rail, "wire");
        assert!(a.counterparty_name.to_uppercase().contains("LAST STOCK"), "cp={}", a.counterparty_name);

        let b = &rows[1];
        assert_eq!(b.posted_at, "2024-06-05");
        assert_eq!(b.amount, 2500.0);
        assert_eq!(b.direction, "out");
        assert_eq!(b.rail, "zelle");
        assert!(b.counterparty_name.to_uppercase().contains("NJH"), "cp={}", b.counterparty_name);
    }

    #[test]
    fn stable_id_is_deterministic_and_prefixed() {
        let r = ParsedRow {
            posted_at: "2024-06-04".into(), amount: 100.0, direction: "in".into(),
            description: "d".into(), memo_raw: String::new(), rail: String::new(),
            category: String::new(), counterparty_name: String::new(),
            fitid: "X".into(), wire_ref: String::new(), check_num: String::new(), balance: 0.0,
        };
        let id1 = stable_id("acct", &r);
        let id2 = stable_id("acct", &r);
        assert_eq!(id1, id2, "same input must yield same id (cross-device dedupe)");
        assert!(id1.starts_with("bt_"));
    }
}
