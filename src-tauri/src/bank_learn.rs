//! R-288 phase 3 — booking a transaction the way the book has always booked it.
//!
//! Pure: rows in, decisions out. `plaid_sync` applies the decisions after each import.
//!
//! The key is the memo and the payee together, with every token that carries a digit
//! dropped, and the direction — so "Workspace_bj cc@google.com CA 09/01" and the same charge
//! next month are one key, while two different payees behind the same generic memo are not
//! (the live book has "U-Haul" rows whose payee is Shell). Only rows a person BOOKED teach,
//! and never a row linked to a deal: those carry a deal decision, not a category habit.
//!
//! Automatic only when history is overwhelming, the category is not deal money, and the memo
//! is not one of the generic ones whose meaning changes with context. Measured on the live
//! book, predicting each booked row only from the rows booked before it: 88 of 89 right
//! (98.9%) at five bookings and 95% agreement with generic memos excluded; three bookings at
//! 90% with them included was 97.3% — transfers to the owner's own accounts and "Zelle
//! payment to …" flip between categories.

use std::collections::HashMap;

use crate::bank_dedup::TxnRow;

/// Categories that can belong to a deal. MUST match `not_deal_money` in `bank_txn_summary`,
/// `DEAL_CAPABLE_CATEGORIES` in FinancialsView.tsx, `BK_DEAL_CAPABLE` in the phone and
/// `not_deal_money` in the server's routes/bank.rs. A deal-money row needs a person to choose
/// the deal, so it is never booked from history.
pub const DEAL_CAPABLE: &[&str] = &["", "receipt", "payment", "merchandise", "shipping", "customs",
    "customer_refund", "supplier_refund", "cash_in", "cash_out"];

/// Memos whose category depends on context rather than on who the money went to.
const GENERIC: &[&str] = &["transfer", "zelle", "venmo", "thank you", "atm", "withdrawal", "deposit",
    "check", "cash", "wire", "payment to", "payment from", "online payment", "automatic payment"];

pub const MIN_BOOKINGS: usize = 5;
pub const MIN_AGREEMENT: f64 = 0.95;

fn words(s: &str) -> String {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty() && !t.chars().any(|c| c.is_ascii_digit()))
        .take(6)
        .collect::<Vec<_>>()
        .join(" ")
}

/// What the book has learned for one row: (memo words, payee words, direction).
pub fn key(r: &TxnRow) -> (String, String, String) {
    (words(&r.desc), words(&r.counterparty_name), r.dir.clone())
}

/// `raw_json` markers this module owns.
#[derive(Default)]
struct Marks { pending: bool, declined: bool, auto_booked: bool }

fn marks(raw: &str) -> Marks {
    let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(raw) else { return Marks::default() };
    Marks {
        pending: o.get("pnd").and_then(|v| v.as_bool()).unwrap_or(false),
        declined: o.get("abx").and_then(|v| v.as_bool()).unwrap_or(false),
        auto_booked: o.get("ab").is_some_and(|v| !v.is_null()),
    }
}

/// One automatic booking: the row, the category history agrees on, and how many bookings
/// taught it.
#[derive(Clone, Debug, PartialEq)]
pub struct AutoBooking { pub id: String, pub category: String, pub bookings: usize }

/// The rows to book from history now.
pub fn auto_bookings(rows: &[TxnRow]) -> Vec<AutoBooking> {
    let mut hist: HashMap<(String, String, String), HashMap<String, usize>> = HashMap::new();
    for r in rows {
        // A row this module booked is not a person's decision, so it teaches nothing — or the
        // habit would reinforce itself.
        if r.reviewed && !r.linked && !r.category.trim().is_empty() && !marks(&r.raw_json).auto_booked {
            *hist.entry(key(r)).or_default().entry(r.category.clone()).or_default() += 1;
        }
    }
    let mut out = Vec::new();
    for r in rows {
        if r.reviewed || r.linked || r.counterparty_type == "loan" { continue; }
        let m = marks(&r.raw_json);
        if m.pending || m.declined { continue; }
        let memo = format!("{} {}", r.desc, r.counterparty_name).to_lowercase();
        if GENERIC.iter().any(|g| memo.contains(g)) { continue; }
        let Some(h) = hist.get(&key(r)) else { continue };
        let total: usize = h.values().sum();
        let Some((cat, n)) = h.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))) else { continue };
        if total < MIN_BOOKINGS || (*n as f64) / (total as f64) < MIN_AGREEMENT { continue; }
        if DEAL_CAPABLE.contains(&cat.as_str()) { continue; }
        out.push(AutoBooking { id: r.id.clone(), category: cat.clone(), bookings: total });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, desc: &str, payee: &str, cat: &str, reviewed: bool) -> TxnRow {
        TxnRow {
            id: id.into(), account: "CARD \u{00b7}\u{00b7}1111".into(), date: "2026-09-01".into(), amount: 42.79,
            dir: "out".into(), desc: desc.into(), counterparty_name: payee.into(), category: cat.into(),
            reviewed, raw_json: "{}".into(), ..Default::default()
        }
    }

    #[test]
    fn five_matching_bookings_book_the_sixth() {
        let mut v: Vec<TxnRow> = (1..=5).map(|i| row(&format!("b{i}"), &format!("Workspace_bj cc@google.com CA 0{i}/01"), "Google Workspace", "software", true)).collect();
        v.push(row("new", "Workspace_bj cc@google.com CA 09/01", "Google Workspace", "other_expense", false));
        assert_eq!(auto_bookings(&v), vec![AutoBooking { id: "new".into(), category: "software".into(), bookings: 5 }]);
    }

    #[test]
    fn too_little_or_split_history_books_nothing() {
        let mut four: Vec<TxnRow> = (1..=4).map(|i| row(&format!("b{i}"), "Shopify", "Shopify", "software", true)).collect();
        four.push(row("new", "Shopify", "Shopify", "", false));
        assert!(auto_bookings(&four).is_empty());

        let mut split: Vec<TxnRow> = (1..=9).map(|i| row(&format!("b{i}"), "Walmart", "Walmart", "office", true)).collect();
        split.push(row("b10", "Walmart", "Walmart", "auto", true));
        split.push(row("new", "Walmart", "Walmart", "", false));
        assert!(auto_bookings(&split).is_empty(), "90% agreement is not enough");
    }

    #[test]
    fn deal_money_generic_memos_pending_declined_and_linked_rows_are_left_alone() {
        let hist = |desc: &str, payee: &str, cat: &str| -> Vec<TxnRow> {
            (1..=6).map(|i| row(&format!("{desc}{i}"), desc, payee, cat, true)).collect()
        };
        let mut v = hist("Freight co", "Freight co", "shipping");
        v.push(row("deal", "Freight co", "Freight co", "", false));
        v.extend(hist("Zelle payment to Pat", "Pat", "owner_draw"));
        v.push(row("generic", "Zelle payment to Pat", "Pat", "", false));
        v.extend(hist("Parking garage", "Parking garage", "travel"));
        let mut pending = row("pending", "Parking garage", "Parking garage", "", false);
        pending.raw_json = r#"{"pnd":true}"#.into();
        let mut declined = row("declined", "Parking garage", "Parking garage", "", false);
        declined.raw_json = r#"{"abx":true}"#.into();
        let mut linked = row("linked", "Parking garage", "Parking garage", "", false);
        linked.linked = true;
        v.extend([pending, declined, linked]);
        assert!(auto_bookings(&v).is_empty());
    }

    #[test]
    fn a_different_payee_behind_the_same_memo_is_a_different_habit() {
        let mut v: Vec<TxnRow> = (1..=7).map(|i| row(&format!("b{i}"), "U-Haul", "U-Haul", "travel", true)).collect();
        v.push(row("shell", "U-Haul", "Shell", "", false));
        assert!(auto_bookings(&v).is_empty());
    }

    #[test]
    fn its_own_bookings_do_not_teach() {
        let mut v: Vec<TxnRow> = (1..=5).map(|i| {
            let mut r = row(&format!("b{i}"), "Canva", "Canva", "software", true);
            r.raw_json = r#"{"ab":"2026-09-01T00:00:00Z"}"#.into();
            r
        }).collect();
        v.push(row("new", "Canva", "Canva", "", false));
        assert!(auto_bookings(&v).is_empty());
    }
}
