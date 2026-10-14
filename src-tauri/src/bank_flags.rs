//! R-518: the two bank-row flags every query must read the same way, in both repos.
//!
//! This file is byte-identical in BUSINESS APP/src-tauri/src and clienthub-api/src. It has no `use crate::`.
//!
//! A bank row carries two flags inside `raw_json`:
//! - `$.pnd`: Plaid served it as pending. The money has not settled; its posted copy will arrive under a new id.
//! - `$.rtr`: the bank withdrew the row after it was booked, so it was kept for a person to resolve (the R-497
//!   Retracted by bank list). The money did not move under this row; if it moved at all, it moved under the
//!   posted copy, which is counted on its own.
//!
//! `raw_json` is read through `json_valid()` (invariant 10: an empty string must never throw).

/// SQL that is true when the row (under `alias`) is pending at the bank.
pub fn pending(alias: &str) -> String {
    format!("COALESCE(CASE WHEN json_valid({a}.raw_json) THEN json_extract({a}.raw_json,'$.pnd') END,0)<>0", a = alias)
}

/// SQL that is true when the bank retracted the row (under `alias`) and it was kept for a person to resolve.
pub fn retracted(alias: &str) -> String {
    format!("CASE WHEN json_valid({a}.raw_json) THEN json_extract({a}.raw_json,'$.rtr') END IS NOT NULL", a = alias)
}

/// SQL that is true when the row (under `alias`) is money that moved under this row: not retracted.
/// Every bank total (P&L, true net, overhead, summaries, Tie out, loan repaid, exports) reads only these rows.
/// A pending row still counts: it is real money in flight, and when its posted copy arrives the bank removes it.
pub fn counted(alias: &str) -> String {
    format!("NOT ({})", retracted(alias))
}

/// SQL that is true when an automatic pass (rules, booking from history) may act on the row: neither pending nor
/// retracted. A pending row is booked once its posted copy arrives, never before.
pub fn settled(alias: &str) -> String {
    format!("NOT ({}) AND NOT ({})", pending(alias), retracted(alias))
}

/// `counted(alias)` as a string literal, for SQL that is a `const` built with `concat!`. The alias is a literal too:
/// `concat!("... WHERE ", bank_counted_sql!("t"), " AND ...")`.
#[macro_export]
macro_rules! bank_counted_sql {
    ($a:literal) => {
        concat!("NOT (CASE WHEN json_valid(", $a, ".raw_json) THEN json_extract(", $a, ".raw_json,'$.rtr') END IS NOT NULL)")
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_literal_form_is_the_same_test() {
        assert_eq!(crate::bank_counted_sql!("t"), counted("t"));
        assert_eq!(crate::bank_counted_sql!("bt"), counted("bt"));
    }

    fn eval(raw: &str, sql: String) -> bool {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE bank_txn (id TEXT, raw_json TEXT)").unwrap();
        c.execute("INSERT INTO bank_txn VALUES ('a', ?1)", [raw]).unwrap();
        c.query_row(&format!("SELECT CASE WHEN {} THEN 1 ELSE 0 END FROM bank_txn t", sql), [], |r| r.get::<_, i64>(0)).unwrap() == 1
    }

    #[test]
    fn flags_read_through_json_valid() {
        assert!(eval(r#"{"pnd":true}"#, pending("t")));
        assert!(!eval(r#"{"pnd":false}"#, pending("t")));
        assert!(!eval("", pending("t")), "an empty raw_json is not pending and does not throw");
        assert!(eval(r#"{"rtr":"2026-10-14T10:00:00Z"}"#, retracted("t")));
        assert!(!eval("not json", retracted("t")));
    }

    #[test]
    fn counted_leaves_out_only_retracted_rows() {
        assert!(eval(r#"{"pnd":true}"#, counted("t")), "pending money in flight still counts");
        assert!(eval("", counted("t")));
        assert!(!eval(r#"{"rtr":"x"}"#, counted("t")));
    }

    #[test]
    fn settled_leaves_out_pending_and_retracted_rows() {
        assert!(eval(r#"{}"#, settled("t")));
        assert!(eval("", settled("t")));
        assert!(!eval(r#"{"pnd":true}"#, settled("t")));
        assert!(!eval(r#"{"rtr":"x","pnd":false}"#, settled("t")));
    }
}
